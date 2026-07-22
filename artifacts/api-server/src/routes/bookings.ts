import { Router, type IRouter } from "express";
import { and, desc, eq, lt } from "drizzle-orm";
import {
  db,
  bookingsTable,
  vehiclesTable,
  customersTable,
  leadsTable,
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
import { logger } from "../lib/logger";
import { ensureAccountForLead } from "../lib/accounts";
import { applyPayment, issueInvoice, logPaymentEvent } from "../lib/invoicing";
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
      .set({ status: "available" })
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
    const paidNow = (parsed.data.amountPaid ?? 0) > 0;
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
    .set({ status: paymentStatus === "paid" ? "booked" : "reserved" })
    .where(
      and(
        eq(vehiclesTable.id, parsed.data.vehicleId),
        eq(vehiclesTable.dealerId, dealerId),
      ),
    );

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
    if (!email) return;
    await enqueueEmail({
      template: "vehicle_booking",
      to: email,
      dealerId: booking!.dealerId,
      customerId: booking!.customerId,
      data: {
        name,
        vehicle: await vehicleLabel(booking!.vehicleId, booking!.dealerId),
        amount: money(booking!.bookingAmount),
      },
    });
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
    await releaseVehicle(booking!.vehicleId, dealerId);
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
