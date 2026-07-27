import { Router, type IRouter } from "express";
import { and, desc, eq, lt } from "drizzle-orm";
import {
  db,
  bookingsTable,
  vehiclesTable,
  customersTable,
  leadsTable,
  dealsTable,
  gatesTable,
  tasksTable,
  timelineEventsTable,
  type Booking,
} from "@workspace/db";
import {
  ListBookingsQueryParams,
  ListBookingsResponse,
  CreateBookingBody,
  CreateBookingResponse,
  GetBookingParams,
  GetBookingResponse,
  UpdateBookingParams,
  UpdateBookingBody,
  UpdateBookingResponse,
  SendBookingPaymentReminderParams,
  SendBookingPaymentReminderResponse,
} from "@workspace/api-zod";
import { enqueueEmail } from "../lib/email";
import {
  notifyReservationPending,
  notifyCancellation,
} from "../lib/notify-triggers";
import {
  refundBlockReason,
  raiseRefundReleaseGate,
  logCancellationEvent,
} from "../lib/cancellation";
import { logger } from "../lib/logger";
import { ensureAccountForLead } from "../lib/accounts";
import { applyPayment, issueInvoice, logPaymentEvent } from "../lib/invoicing";
import { recordAgentRun } from "../lib/agent-governance";
import { defaultDivisionId } from "./divisions";
import { activeDealerId } from "../middlewares/rbac";

const router: IRouter = Router();

const money = (n: number) =>
  `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

async function vehicleLabel(
  vehicleId: number,
  dealerId: number,
): Promise<string> {
  const [v] = await db
    .select({
      year: vehiclesTable.year,
      make: vehiclesTable.make,
      model: vehiclesTable.model,
    })
    .from(vehiclesTable)
    .where(
      and(
        eq(vehiclesTable.id, vehicleId),
        eq(vehiclesTable.dealerId, dealerId),
      ),
    );
  return v ? `${v.year} ${v.make} ${v.model}` : `Vehicle #${vehicleId}`;
}

/** Releases the vehicle back to available if no other active booking holds it. */
async function releaseVehicle(
  vehicleId: number,
  dealerId: number,
): Promise<void> {
  const [other] = await db
    .select({ id: bookingsTable.id })
    .from(bookingsTable)
    .where(
      and(
        eq(bookingsTable.vehicleId, vehicleId),
        eq(bookingsTable.status, "active"),
        eq(bookingsTable.dealerId, dealerId),
      ),
    );
  if (other) return;
  const [v] = await db
    .select({ status: vehiclesTable.status })
    .from(vehiclesTable)
    .where(
      and(
        eq(vehiclesTable.id, vehicleId),
        eq(vehiclesTable.dealerId, dealerId),
      ),
    );
  if (v && (v.status === "reserved" || v.status === "booked")) {
    await db
      .update(vehiclesTable)
      .set({ status: "available", holdUntil: null, holdReason: null })
      .where(
        and(
          eq(vehiclesTable.id, vehicleId),
          eq(vehiclesTable.dealerId, dealerId),
        ),
      );
  }
}

/** Lazily expires lapsed active bookings and releases their vehicles. */
export async function expireLapsedBookings(): Promise<void> {
  const lapsed = await db
    .update(bookingsTable)
    .set({ status: "expired" })
    .where(
      and(
        eq(bookingsTable.status, "active"),
        lt(bookingsTable.expiresAt, new Date()),
      ),
    )
    .returning();
  for (const b of lapsed) {
    logger.info({ bookingId: b.id }, "booking expired, releasing vehicle");
    await releaseVehicle(b.vehicleId, b.dealerId);
    await revertLeadOnExpiredBooking(b);
  }
}

/**
 * Pre-Book expiry (L4): a reservation that lapses with the fee UNPAID (and no
 * trusted-bypass waiver) reverts the verbal commit — reservationFeePaid is
 * cleared and, if the lead had reached Booking Confirmed (won) without a
 * committed/delivered deal, the phase drops back to negotiation.
 */
async function revertLeadOnExpiredBooking(b: Booking): Promise<void> {
  if (!b.leadId) return;
  const unpaid = b.amountPaid <= 0 && !b.waiverReason;
  if (!unpaid) return;
  try {
    const [lead] = await db
      .select()
      .from(leadsTable)
      .where(
        and(eq(leadsTable.id, b.leadId), eq(leadsTable.dealerId, b.dealerId)),
      );
    if (!lead) return;

    const leadDeals = await db
      .select({ stage: dealsTable.stage })
      .from(dealsTable)
      .where(
        and(
          eq(dealsTable.leadId, lead.id),
          eq(dealsTable.dealerId, b.dealerId),
        ),
      );
    const dealLocked = leadDeals.some(
      (d) => d.stage === "committed" || d.stage === "delivered",
    );
    const revertPhase = lead.phase === "won" && !dealLocked;

    await db
      .update(leadsTable)
      .set({
        reservationFeePaid: false,
        ...(revertPhase
          ? { phase: "negotiation", stageEnteredAt: new Date() }
          : {}),
      })
      .where(eq(leadsTable.id, lead.id));

    await db.insert(timelineEventsTable).values({
      dealerId: b.dealerId,
      customerId: b.customerId,
      domain: "leads",
      kind: "booking_expired",
      title: `Reservation expired unpaid — booking #${b.id}`,
      detail: revertPhase
        ? "The reservation lapsed with no fee collected. The vehicle was released and the lead reverted to Negotiation."
        : "The reservation lapsed with no fee collected. The vehicle was released and the reservation-fee gate re-opened.",
      actor: "AURA",
      isAgent: true,
      refType: "lead",
      refId: lead.id,
    });
  } catch (err) {
    logger.error(
      { err, bookingId: b.id, leadId: b.leadId },
      "expired-booking lead revert failed",
    );
  }
}

/**
 * Pre-Book follow-through (L4): a reservation from a lead is a verbal commit —
 * auto-desk a draft deal if none exists (kill-switch governed, mirrors the
 * Negotiation auto-desk) and raise a 24h confirmation follow-up task for the
 * lead owner.
 */
async function preBookFollowThrough(
  booking: Booking,
  leadId: number,
  dealerId: number,
  actorUserId: number | null,
): Promise<void> {
  try {
    const [lead] = await db
      .select()
      .from(leadsTable)
      .where(
        and(eq(leadsTable.id, leadId), eq(leadsTable.dealerId, dealerId)),
      );
    if (!lead) return;

    // Auto-desk a draft deal at listed price when none exists yet.
    let dealId = booking.dealId;
    if (!dealId) {
      const leadDeals = await db
        .select({ id: dealsTable.id })
        .from(dealsTable)
        .where(
          and(eq(dealsTable.dealerId, dealerId), eq(dealsTable.leadId, leadId)),
        );
      // Deterministic transactional side effect of the human's booking action
      // — not an AI write, so no kill switch (R3.2); audited as system.
      if (leadDeals.length === 0) {
        const startedAt = Date.now();
        const [vehicle] = await db
          .select()
          .from(vehiclesTable)
          .where(
            and(
              eq(vehiclesTable.id, booking.vehicleId),
              eq(vehiclesTable.dealerId, dealerId),
            ),
          );
        if (vehicle) {
          const [autoDeal] = await db
            .insert(dealsTable)
            .values({
              dealerId,
              leadId,
              customerId: booking.customerId ?? lead.customerId ?? null,
              customerName: lead.name,
              vehicleId: vehicle.id,
              vehiclePrice: vehicle.price,
              discount: 0,
              divisionId:
                vehicle.divisionId ?? (await defaultDivisionId(dealerId)),
              salesAdvisor: lead.assignedTo ?? null,
            })
            .returning();
          if (autoDeal) {
            dealId = autoDeal.id;
            await db
              .update(bookingsTable)
              .set({ dealId: autoDeal.id })
              .where(eq(bookingsTable.id, booking.id));
            await db.insert(timelineEventsTable).values({
              dealerId,
              customerId: booking.customerId ?? lead.customerId,
              domain: "leads",
              kind: "deal_created",
              title: "Deal auto-desked by AURA at pre-book",
              detail: `Draft deal #${autoDeal.id} created at the vehicle's listed price when the reservation was placed — review and adjust the numbers.`,
              actor: "AURA System",
              isAgent: false,
              refType: "lead",
              refId: leadId,
            });
            await recordAgentRun({
              dealerId,
              agentKey: "auto_desk",
              runType: "auto_desk_deal",
              autonomy: "system",
              inputSource: "pre_book",
              inputSummary: `Reservation #${booking.id} placed for lead #${leadId} with no deal on file`,
              outputSummary: `Drafted deal #${autoDeal.id} at listed price for vehicle #${vehicle.id}`,
              confidence: 1,
              refType: "deal",
              refId: autoDeal.id,
              latencyMs: Date.now() - startedAt,
              mutation: true,
              changeSummary: `No deal on file → draft deal #${autoDeal.id} created at listed price ${vehicle.price} with 0 discount`,
              affectedEntities: [
                { type: "deal", id: autoDeal.id },
                { type: "lead", id: leadId },
              ],
            });
          }
        }
      }
    }

    // Verbal-commit follow-up: unpaid (non-waived) reservations get a 24h
    // confirmation task assigned to the lead owner.
    if (booking.amountPaid <= 0 && !booking.waiverReason) {
      const dueAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await db.insert(tasksTable).values({
        dealerId,
        title: `Confirm reservation fee — ${lead.name} (booking #${booking.id})`,
        description: `Verbal commit recorded: reservation #${booking.id} was placed without payment. Collect the fee or record a manager-approved waiver before it expires${booking.expiresAt ? ` on ${booking.expiresAt.toISOString().slice(0, 10)}` : ""}.`,
        assigneeUserId: lead.ownerUserId ?? actorUserId,
        createdByUserId: actorUserId,
        leadId,
        dueAt,
        dueDate: dueAt.toISOString().slice(0, 10),
        kind: "callback",
        priority: "high",
      });
    }
  } catch (err) {
    logger.error(
      { err, bookingId: booking.id, leadId },
      "pre-book follow-through failed",
    );
  }
}

async function bookingRecipient(
  booking: Booking,
): Promise<{ email: string | null; name: string }> {
  if (!booking.customerId) return { email: null, name: booking.customerName };
  const [c] = await db
    .select({ email: customersTable.email, name: customersTable.name })
    .from(customersTable)
    .where(
      and(
        eq(customersTable.id, booking.customerId),
        eq(customersTable.dealerId, booking.dealerId),
      ),
    );
  return {
    email: c?.email ?? null,
    name: c?.name ?? booking.customerName,
  };
}

/** Full contact card (email + phone) for a booking's customer. */
async function bookingContact(
  booking: Booking,
): Promise<{ email: string | null; phone: string | null }> {
  if (!booking.customerId) return { email: null, phone: null };
  const [c] = await db
    .select({ email: customersTable.email, phone: customersTable.phone })
    .from(customersTable)
    .where(
      and(
        eq(customersTable.id, booking.customerId),
        eq(customersTable.dealerId, booking.dealerId),
      ),
    );
  return { email: c?.email ?? null, phone: c?.phone ?? null };
}

/** The advisor on the booking's lead (owner), when the booking came from one. */
async function bookingAdvisorUserId(booking: Booking): Promise<number | null> {
  if (!booking.leadId) return null;
  const [lead] = await db
    .select({ ownerUserId: leadsTable.ownerUserId })
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.id, booking.leadId),
        eq(leadsTable.dealerId, booking.dealerId),
      ),
    );
  return lead?.ownerUserId ?? null;
}

router.get("/bookings", async (req, res): Promise<void> => {
  const query = ListBookingsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  await expireLapsedBookings();

  const filters = [eq(bookingsTable.dealerId, activeDealerId(res))];
  if (query.data.status)
    filters.push(eq(bookingsTable.status, query.data.status));
  if (query.data.vehicleId !== undefined)
    filters.push(eq(bookingsTable.vehicleId, query.data.vehicleId));

  const rows = await db
    .select()
    .from(bookingsTable)
    .where(and(...filters))
    .orderBy(desc(bookingsTable.createdAt));

  res.json(ListBookingsResponse.parse(rows));
});

router.post("/bookings", async (req, res): Promise<void> => {
  const parsed = CreateBookingBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  await expireLapsedBookings();
  const dealerId = activeDealerId(res);

  // Reservation fee is MANDATORY (L4). The only exception is the trusted
  // bypass for fleet/repeat VIP buyers: bookingAmount=0 recorded with a
  // waiverReason, backed by a manager-approval gate raised below.
  const waiverReason = parsed.data.waiverReason?.trim() || null;
  if (parsed.data.bookingAmount <= 0 && !waiverReason) {
    res.status(422).json({
      error:
        "Reservation fee is mandatory — collect the fee or record a trusted-customer waiver reason (manager approval required)",
    });
    return;
  }
  if (waiverReason && parsed.data.bookingAmount > 0) {
    res.status(422).json({
      error:
        "A trusted-bypass waiver only applies to zero-fee reservations — remove the waiver or set the booking amount to 0",
    });
    return;
  }

  // One active reservation per lead: amend the existing booking instead.
  if (parsed.data.leadId !== undefined) {
    const [existing] = await db
      .select({ id: bookingsTable.id })
      .from(bookingsTable)
      .where(
        and(
          eq(bookingsTable.dealerId, dealerId),
          eq(bookingsTable.leadId, parsed.data.leadId),
          eq(bookingsTable.status, "active"),
        ),
      );
    if (existing) {
      res.status(409).json({
        error: `This lead already has an active reservation (booking #${existing.id}) — amend it instead of creating a second one`,
      });
      return;
    }
  }

  const [vehicle] = await db
    .select()
    .from(vehiclesTable)
    .where(
      and(
        eq(vehiclesTable.id, parsed.data.vehicleId),
        eq(vehiclesTable.dealerId, dealerId),
      ),
    );
  if (!vehicle) {
    res.status(404).json({ error: "Vehicle not found" });
    return;
  }
  if (vehicle.status !== "available") {
    res.status(409).json({
      error: `Vehicle is ${vehicle.status} and cannot be booked`,
    });
    return;
  }
  // Soft-lock: an unexpired hold keeps the unit visible but unbookable.
  if (vehicle.holdUntil && vehicle.holdUntil.getTime() > Date.now()) {
    res.status(409).json({
      error: `Vehicle is on hold${vehicle.holdReason ? ` (${vehicle.holdReason})` : ""} until ${vehicle.holdUntil.toISOString()} and cannot be booked`,
    });
    return;
  }

  // Reservation from a lead (Pre-Book): promote the lead to an Account with a
  // primary Contact, and lock the Selected Model on the lead.
  let customerId = parsed.data.customerId ?? null;
  if (parsed.data.leadId !== undefined) {
    const [lead] = await db
      .select()
      .from(leadsTable)
      .where(
        and(
          eq(leadsTable.id, parsed.data.leadId),
          eq(leadsTable.dealerId, dealerId),
        ),
      );
    if (!lead) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    const linkedId = await ensureAccountForLead(lead, "reservation");
    if (linkedId) customerId = customerId ?? linkedId;

    const selectedModel = `${vehicle.year} ${vehicle.make} ${vehicle.model}`;
    // A trusted-bypass waiver counts as fee-satisfied (subject to the
    // pending manager-approval gate raised below).
    const paidNow = (parsed.data.amountPaid ?? 0) > 0 || Boolean(waiverReason);
    await db
      .update(leadsTable)
      .set({
        selectedModel,
        ...(paidNow ? { reservationFeePaid: true } : {}),
      })
      .where(eq(leadsTable.id, lead.id));

    if (customerId) {
      try {
        await db.insert(timelineEventsTable).values({
          dealerId,
          customerId,
          domain: "leads",
          kind: "model_selected",
          title: `Selected model locked: ${selectedModel}`,
          detail: `Reservation placed — ${selectedModel} is now the selected model for this account.`,
          actor: "AURA",
          isAgent: true,
          refType: "lead",
          refId: lead.id,
        });
      } catch (err) {
        logger.error({ err, leadId: lead.id }, "selected-model receipt failed");
      }
    }
  }

  const paid = parsed.data.amountPaid ?? 0;
  const paymentStatus =
    parsed.data.paymentStatus ??
    (paid >= parsed.data.bookingAmount && parsed.data.bookingAmount > 0
      ? "paid"
      : paid > 0
        ? "partial"
        : "pending");

  const [booking] = await db
    .insert(bookingsTable)
    .values({
      dealerId,
      vehicleId: parsed.data.vehicleId,
      customerId,
      customerName: parsed.data.customerName,
      dealId: parsed.data.dealId ?? null,
      leadId: parsed.data.leadId ?? null,
      waiverReason,
      bookingAmount: parsed.data.bookingAmount,
      amountPaid: paid,
      paymentStatus,
      status: "active",
      expiresAt: parsed.data.expiresAt,
      notes: parsed.data.notes ?? null,
      createdBy: res.locals.user?.name ?? res.locals.user?.email ?? null,
    })
    .returning();

  await db
    .update(vehiclesTable)
    .set({
      status: paymentStatus === "paid" ? "booked" : "reserved",
      // Soft-lock the unit for the life of the reservation; expiry/cancel
      // clears it via releaseVehicle.
      holdUntil: parsed.data.expiresAt,
      holdReason: "booking",
    })
    .where(
      and(
        eq(vehiclesTable.id, parsed.data.vehicleId),
        eq(vehiclesTable.dealerId, dealerId),
      ),
    );

  // Trusted-bypass waiver: raise a pending manager-approval gate so the
  // zero-fee reservation is visible and reviewable.
  if (waiverReason) {
    try {
      await db.insert(gatesTable).values({
        dealerId,
        type: "fee_waiver",
        status: "pending",
        priority: "high",
        customerId: booking!.customerId,
        customerName: booking!.customerName,
        title: `Reservation-fee waiver — booking #${booking!.id} (${booking!.customerName})`,
        summary: `Trusted-customer bypass requested by ${booking!.createdBy ?? "staff"}: ${waiverReason}`,
        refType: "booking",
        refId: booking!.id,
        evidence: [
          { label: "Booking", value: `#${booking!.id}` },
          { label: "Waiver reason", value: waiverReason },
        ],
      });
    } catch (err) {
      logger.error({ err, bookingId: booking!.id }, "fee-waiver gate failed");
    }
  }

  if (parsed.data.leadId !== undefined) {
    await preBookFollowThrough(
      booking!,
      parsed.data.leadId,
      dealerId,
      res.locals.user?.id ?? null,
    );
  }

  // Dual-invoice #1 (L6): every reservation with a fee issues a reservation
  // invoice; anything paid up-front is applied immediately (payment + receipt).
  if (booking!.bookingAmount > 0) {
    try {
      const vehicleName = await vehicleLabel(booking!.vehicleId, dealerId);
      const invoice = await issueInvoice({
        dealerId,
        kind: "reservation",
        customerName: booking!.customerName,
        amount: booking!.bookingAmount,
        customerId: booking!.customerId,
        dealId: booking!.dealId,
        description: `Reservation fee — ${vehicleName} (booking #${booking!.id})`,
      });
      if (paid > 0) {
        const applied = Math.min(paid, booking!.bookingAmount);
        const result = await applyPayment({
          invoice,
          amount: applied,
          method: "cash",
          reference: `booking-${booking!.id}`,
          receivedBy: booking!.createdBy,
        });
        await logPaymentEvent(
          invoice,
          applied,
          "cash",
          result.receipt.receiptNumber,
        );
      }
    } catch (err) {
      logger.error(
        { err, bookingId: booking!.id },
        "reservation invoice issuance failed",
      );
    }
  }

  void (async () => {
    const { email, name } = await bookingRecipient(booking!);
    const vehicleName = await vehicleLabel(booking!.vehicleId, booking!.dealerId);
    if (email) {
      await enqueueEmail({
        template: "vehicle_booking",
        to: email,
        dealerId: booking!.dealerId,
        customerId: booking!.customerId,
        data: {
          name,
          vehicle: vehicleName,
          amount: money(booking!.bookingAmount),
        },
      });
    }
    // R6.2 #6 Reservation Pending — fee not yet (fully) received: nudge the
    // customer (WhatsApp + Email) and put an In-App row on the advisor.
    if (booking!.paymentStatus !== "paid" && booking!.bookingAmount > 0) {
      const contact = await bookingContact(booking!);
      notifyReservationPending({
        bookingId: booking!.id,
        dealerId: booking!.dealerId,
        customerId: booking!.customerId,
        leadId: booking!.leadId,
        customerName: name,
        customerEmail: contact.email,
        customerPhone: contact.phone,
        vehicle: vehicleName,
        amount: money(booking!.bookingAmount - booking!.amountPaid),
        expiresAt: booking!.expiresAt,
        advisorUserId: await bookingAdvisorUserId(booking!),
      });
    }
  })().catch((err) =>
    logger.error({ err, bookingId: booking!.id }, "booking email failed"),
  );

  res.status(201).json(CreateBookingResponse.parse(booking));
});

router.get("/bookings/:id", async (req, res): Promise<void> => {
  const params = GetBookingParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [booking] = await db
    .select()
    .from(bookingsTable)
    .where(
      and(
        eq(bookingsTable.id, params.data.id),
        eq(bookingsTable.dealerId, activeDealerId(res)),
      ),
    );
  if (!booking) {
    res.status(404).json({ error: "Booking not found" });
    return;
  }
  res.json(GetBookingResponse.parse(booking));
});

router.patch("/bookings/:id", async (req, res): Promise<void> => {
  const params = UpdateBookingParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateBookingBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const dealerId = activeDealerId(res);
  const [before] = await db
    .select()
    .from(bookingsTable)
    .where(
      and(
        eq(bookingsTable.id, params.data.id),
        eq(bookingsTable.dealerId, dealerId),
      ),
    );
  if (!before) {
    res.status(404).json({ error: "Booking not found" });
    return;
  }
  if (before.status !== "active" && parsed.data.status === "active") {
    res.status(422).json({
      error: `Cannot reactivate a ${before.status} booking`,
    });
    return;
  }

  // Cancel Reservation (L9): a cancellation with captured funds must still be
  // inside the refundable-until-registration window; the refund itself (and
  // the vehicle release) then waits on a manager-approved refund_release gate.
  const isCancelling =
    parsed.data.status === "cancelled" && before.status === "active";
  const refundDue = isCancelling && before.amountPaid > 0.005;
  if (isCancelling && !parsed.data.cancellationReason) {
    res.status(422).json({
      error: "cancellation_reason_required",
      unmet: ["Select a cancellation reason before cancelling the reservation"],
    });
    return;
  }
  if (refundDue) {
    const blocked = await refundBlockReason({
      dealerId,
      dealId: before.dealId,
      vehicleId: before.vehicleId,
    });
    if (blocked) {
      res.status(422).json({ error: "refund_window_closed", unmet: [blocked] });
      return;
    }
  }

  const next: Record<string, unknown> = { ...parsed.data };
  // Recompute payment status when a payment is recorded without one.
  if (
    parsed.data.amountPaid !== undefined &&
    parsed.data.paymentStatus === undefined
  ) {
    next.paymentStatus =
      parsed.data.amountPaid >= before.bookingAmount && before.bookingAmount > 0
        ? "paid"
        : parsed.data.amountPaid > 0
          ? "partial"
          : "pending";
  }

  const [booking] = await db
    .update(bookingsTable)
    .set(next)
    .where(
      and(
        eq(bookingsTable.id, params.data.id),
        eq(bookingsTable.dealerId, dealerId),
      ),
    )
    .returning();

  // Vehicle side effects: fully paid → booked; cancelled/expired → release.
  if (booking!.status === "active" && booking!.paymentStatus === "paid") {
    await db
      .update(vehiclesTable)
      .set({ status: "booked" })
      .where(
        and(
          eq(vehiclesTable.id, booking!.vehicleId),
          eq(vehiclesTable.status, "reserved"),
          eq(vehiclesTable.dealerId, dealerId),
        ),
      );
  }
  if (
    (booking!.status === "cancelled" || booking!.status === "expired") &&
    before.status === "active"
  ) {
    if (refundDue) {
      // Hold NOT cleared yet — the refund_release gate approval releases it.
      const gateId = await raiseRefundReleaseGate({
        dealerId,
        refType: "booking",
        refId: booking!.id,
        customerId: booking!.customerId,
        customerName: booking!.customerName,
        amount: booking!.amountPaid,
        reasonCode: booking!.cancellationReason ?? "other",
        reasonNote: booking!.cancellationNote,
        evidence: [
          { label: "Booking", value: `#${booking!.id}` },
          {
            label: "Vehicle",
            value: await vehicleLabel(booking!.vehicleId, dealerId),
          },
          { label: "Vehicle hold", value: "Held until refund release is approved" },
        ],
      });
      await logCancellationEvent({
        dealerId,
        customerId: booking!.customerId,
        refType: "booking",
        refId: booking!.id,
        title: "Reservation cancelled — refund release pending",
        detail: `Cancellation (${booking!.cancellationReason ?? "other"}) recorded with $${booking!.amountPaid.toLocaleString()} captured. Refund gate #${gateId} raised for manager approval; the vehicle hold stays in place until it is approved.`,
        actor: booking!.createdBy ?? "Advisor",
      });
    } else {
      await releaseVehicle(booking!.vehicleId, dealerId);
      if (booking!.status === "cancelled") {
        await logCancellationEvent({
          dealerId,
          customerId: booking!.customerId,
          refType: "booking",
          refId: booking!.id,
          title: "Reservation cancelled",
          detail: `Cancellation (${booking!.cancellationReason ?? "other"}) recorded with no captured funds; the vehicle hold was released.`,
          actor: booking!.createdBy ?? "Advisor",
        });
      }
    }
  }

  // R6.2 #9 Cancellation → reporting/division managers (In-App + Email).
  if (booking!.status === "cancelled" && before.status === "active") {
    notifyCancellation({
      dealerId,
      entityType: "booking",
      entityId: booking!.id,
      label: `Reservation #${booking!.id} — ${booking!.customerName}`,
      reason: booking!.cancellationReason ?? booking!.cancellationNote,
      advisorUserId: await bookingAdvisorUserId(booking!),
    });
  }

  res.json(UpdateBookingResponse.parse(booking));
});

router.post("/bookings/:id/remind", async (req, res): Promise<void> => {
  const params = SendBookingPaymentReminderParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [booking] = await db
    .select()
    .from(bookingsTable)
    .where(
      and(
        eq(bookingsTable.id, params.data.id),
        eq(bookingsTable.dealerId, activeDealerId(res)),
      ),
    );
  if (!booking) {
    res.status(404).json({ error: "Booking not found" });
    return;
  }
  const outstanding = booking.bookingAmount - booking.amountPaid;
  if (outstanding <= 0) {
    res.status(422).json({ error: "Nothing outstanding on this booking" });
    return;
  }
  const { email, name } = await bookingRecipient(booking);
  if (!email) {
    res.status(422).json({ error: "Customer has no email on file" });
    return;
  }
  await enqueueEmail({
    template: "payment_reminder",
    to: email,
    dealerId: booking.dealerId,
    customerId: booking.customerId,
    data: {
      name,
      vehicle: await vehicleLabel(booking.vehicleId, booking.dealerId),
      amount: money(outstanding),
      due: booking.expiresAt.toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      }),
    },
  });
  res.json(SendBookingPaymentReminderResponse.parse(booking));
});

export default router;
