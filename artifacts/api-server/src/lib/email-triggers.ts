import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, like } from "drizzle-orm";
import {
  db,
  customersTable,
  deliveriesTable,
  vehiclesTable,
  type Lead,
  type Deal,
  type ServiceOrder,
  type ServiceInvoice,
  usersTable,
  dealerUsersTable,
  dealersTable,
  emailLogsTable,
  jobCardsTable,
  jobCardPartsTable,
  serviceEstimateDecisionsTable,
  serviceInvoicesTable,
  feedbackInvitationsTable,
  type JobCard,
  type ServiceEstimateLine,
} from "@workspace/db";
import { enqueueEmail, type TemplateData } from "./email";

/** Name + phone of the lead's assigned (round-robin) sales advisor. */
export async function leadAdvisorContact(
  lead: Lead,
): Promise<{ name: string | null; phone: string | null } | null> {
  if (!lead.ownerUserId) return null;
  // Tenancy: only surface the advisor if they are a member of the lead's
  // dealership — a stale ownerUserId must never leak another dealer's staff.
  const [u] = await db
    .select({
      name: usersTable.name,
      email: usersTable.email,
      phone: usersTable.phone,
    })
    .from(usersTable)
    .innerJoin(
      dealerUsersTable,
      and(
        eq(dealerUsersTable.userId, usersTable.id),
        eq(dealerUsersTable.dealerId, lead.dealerId),
      ),
    )
    .where(eq(usersTable.id, lead.ownerUserId));
  if (!u) return null;
  return { name: u.name ?? u.email ?? null, phone: u.phone ?? null };
}
import {
  ownerCalendarContact,
  serviceCalendarFields,
  testDriveCalendarFields,
} from "./calendar";
import { logger } from "./logger";
import {
  dealerTimezone,
  formatDealerDate,
  formatDealerSlot,
  formatDealerTime,
} from "./timezone";

// ---------------------------------------------------------------------------
// Lifecycle email triggers — fire-and-forget, never fail the request
// ---------------------------------------------------------------------------

const money = (n: number) =>
  `GY$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

const fullMonthDate = (
  value: string | Date,
  tz: string,
): string =>
  formatDealerDate(value, tz).replace(
    /^([A-Z][a-z]{2}) /,
    (short) =>
      ({
        Jan: "January ",
        Feb: "February ",
        Mar: "March ",
        Apr: "April ",
        May: "May ",
        Jun: "June ",
        Jul: "July ",
        Aug: "August ",
        Sep: "September ",
        Oct: "October ",
        Nov: "November ",
        Dec: "December ",
      })[short.trim()] ?? short,
  );

async function customerEmail(
  dealerId: number,
  customerId: number | null | undefined,
): Promise<{ email: string | null; name: string | null }> {
  if (!customerId) return { email: null, name: null };
  const [c] = await db
    .select({ email: customersTable.email, name: customersTable.name })
    .from(customersTable)
    .where(
      and(
        eq(customersTable.id, customerId),
        eq(customersTable.dealerId, dealerId),
      ),
    );
  return { email: c?.email ?? null, name: c?.name ?? null };
}

async function vehicleName(
  dealerId: number,
  vehicleId: number | null | undefined,
): Promise<string | null> {
  if (!vehicleId) return null;
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
  return v ? `${v.make} ${v.model}` : null;
}

function fire(
  label: string,
  fn: () => Promise<void>,
): void {
  void fn().catch((err) => {
    logger.error({ err, trigger: label }, "lifecycle email trigger failed");
  });
}

async function send(opts: {
  dealerId: number;
  template: Parameters<typeof enqueueEmail>[0]["template"];
  to: string | null | undefined;
  customerId?: number | null;
  data?: TemplateData;
}): Promise<void> {
  if (!opts.to) return;
  await enqueueEmail({
    dealerId: opts.dealerId,
    template: opts.template,
    to: opts.to,
    customerId: opts.customerId ?? null,
    data: opts.data ?? {},
  });
}

async function leadRecipient(
  lead: Lead,
): Promise<{ to: string | null; name: string }> {
  if (lead.email) return { to: lead.email, name: lead.name };
  const c = await customerEmail(lead.dealerId, lead.customerId);
  return { to: c.email, name: c.name ?? lead.name };
}

/** Public origin for customer-facing links (production domain first). */
function publicAppOrigin(): string | null {
  const prod = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
  const dev = process.env.REPLIT_DEV_DOMAIN?.trim();
  const host = prod || dev;
  return host ? `https://${host}` : null;
}

/** Self-service test-drive booking URL for a lead's invite token. */
export function testDriveBookingUrl(token: string): string | null {
  const origin = publicAppOrigin();
  return origin ? `${origin}/book-test-drive/${token}` : null;
}

/** Public customer feedback form URL for an invitation token. */
export function feedbackFormUrl(token: string): string | null {
  const origin = publicAppOrigin();
  return origin ? `${origin}/feedback/${token}` : null;
}

/**
 * New lead created → personalised PDF quote when a vehicle of interest is on
 * file (details pulled from inventory), otherwise the "lead_received" welcome.
 */
export function onLeadCreated(lead: Lead, fallbackVehicleName?: string): void {
  fire("lead_created", async () => {
    const { to, name } = await leadRecipient(lead);
    if (!to) return;

    const vehicleId = lead.interestedVehicleId;
    const [v] = vehicleId
      ? await db
          .select()
          .from(vehiclesTable)
          .where(
            and(
              eq(vehiclesTable.id, vehicleId),
              eq(vehiclesTable.dealerId, lead.dealerId),
            ),
          )
      : [];

    if (!v) {
      await send({
        dealerId: lead.dealerId,
        template: "lead_received",
        to,
        customerId: lead.customerId,
        data: {
          name,
          ...(fallbackVehicleName ? { vehicle: fallbackVehicleName } : {}),
        },
      });
    }
    // Leads with a vehicle interest are handled by the quote agent, which
    // generates, snapshots, and queues the canonical quote revision. Keeping
    // this trigger welcome-only prevents a second legacy quote email.

    // NOTE: the self-service test-drive booking invite is NOT sent
    // automatically — staff trigger it from the lead page when appropriate
    // (see sendTestDriveInviteEmail).
  });
}

/**
 * Manually-triggered self-service test-drive booking invite. Sent only when
 * staff hit the CTA on the lead page — never automatically.
 */
export async function sendTestDriveInviteEmail(
  lead: Lead,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const { to, name } = await leadRecipient(lead);
  if (!to) {
    return {
      ok: false,
      status: 422,
      error: "This lead has no email address on file.",
    };
  }
  if (lead.testDriveAt) {
    return {
      ok: false,
      status: 409,
      error: "A test drive is already scheduled for this lead.",
    };
  }
  // The invite carries the customer's self-service booking link (slots are
  // filtered by advisor + vehicle capacity), with the assigned sales
  // advisor's contact riding along for questions.
  const advisor = await leadAdvisorContact(lead);
  const vehicle = await vehicleName(lead.dealerId, lead.interestedVehicleId);
  const bookingLink = testDriveBookingUrl(lead.testDriveToken);
  await send({
    dealerId: lead.dealerId,
    template: "test_drive_invite",
    to,
    customerId: lead.customerId,
    data: {
      name,
      ...(advisor?.name ? { advisorName: advisor.name } : {}),
      ...(advisor?.phone ? { advisorPhone: advisor.phone } : {}),
      ...(vehicle ? { vehicle } : {}),
      ...(bookingLink ? { link: bookingLink } : {}),
    },
  });
  return { ok: true };
}

/** Lead updated → advisor introduction / test-drive confirmation. */
export function onLeadUpdated(before: Lead, after: Lead): void {
  fire("lead_updated", async () => {
    const { to } = await leadRecipient(after);
    if (!to) return;
    const vehicle = await vehicleName(after.dealerId, after.interestedVehicleId);
    const tz = await dealerTimezone(after.dealerId);
    const slot = after.testDriveAt
      ? formatDealerSlot(after.testDriveAt, tz)
      : null;

    if (after.assignedTo && after.assignedTo !== before.assignedTo) {
      await send({
        dealerId: after.dealerId,
        template: "lead_assignment",
        to,
        customerId: after.customerId,
        data: {
          advisor: after.assignedTo,
          ...(vehicle ? { vehicle } : {}),
        },
      });
    }
    // "qualified" is the Appointment phase — confirm the test drive (with a
    // calendar invite when a drive time is already on file).
    if (after.phase === "qualified" && before.phase !== "qualified") {
      const owner = after.testDriveAt
        ? await ownerCalendarContact(after.ownerUserId)
        : null;
      await send({
        dealerId: after.dealerId,
        template: "test_drive_confirmation",
        to,
        customerId: after.customerId,
        data: {
          ...(vehicle ? { vehicle } : {}),
          ...(after.testDriveAt
            ? {
                date: slot!.split(" at ")[0]!,
                time: formatDealerTime(after.testDriveAt, tz),
              }
            : {}),
          ...testDriveCalendarFields(after, vehicle ?? null, owner),
        },
      });
    }
  });
}

async function dealRecipient(
  deal: Deal,
): Promise<{ to: string | null; name: string | null }> {
  const c = await customerEmail(deal.dealerId, deal.customerId);
  return { to: c.email, name: c.name ?? deal.customerName };
}

/** Deal stage transitions → finance / booking / delivery emails. */
export function onDealStageChanged(before: Deal, after: Deal): void {
  if (before.stage === after.stage) return;
  fire("deal_stage_changed", async () => {
    const { to, name } = await dealRecipient(after);
    if (!to) return;
    const vehicle = await vehicleName(after.dealerId, after.vehicleId);
    const base: TemplateData = {
      ...(name ? { name } : {}),
      ...(vehicle ? { vehicle } : {}),
      amount: money(after.otdPrice || after.vehiclePrice),
    };

    switch (after.stage) {
      case "finance":
        await send({
          dealerId: after.dealerId,
          template: "finance_processing",
          to,
          customerId: after.customerId,
          data: base,
        });
        break;
      case "committed":
        await send({
          dealerId: after.dealerId,
          template: "finance_approved",
          to,
          customerId: after.customerId,
          data: base,
        });
        await send({
          dealerId: after.dealerId,
          template: "vehicle_booking",
          to,
          customerId: after.customerId,
          data: base,
        });
        break;
      case "delivered": {
        // Normally onDeliveryCompleted sends this (delivery workflow final
        // step); this covers any direct deal-stage hop. Dedupe key parity —
        // keyed on the deal's delivery when one exists — guarantees the
        // customer receives exactly one confirmation either way.
        const [deliveryRow] = await db
          .select({ id: deliveriesTable.id })
          .from(deliveriesTable)
          .where(
            and(
              eq(deliveriesTable.dealId, after.id),
              eq(deliveriesTable.dealerId, after.dealerId),
            ),
          )
          .limit(1);
        await enqueueEmail({
          dealerId: after.dealerId,
          template: "delivery_confirmation",
          to,
          customerId: after.customerId,
          dedupeKey: deliveryRow
            ? `delivery_confirmation:${deliveryRow.id}`
            : `delivery_confirmation:deal-${after.id}`,
          data: base,
        });
        break;
      }
    }
  });
}

/** Finance application status transitions → processing / approved emails. */
export function onFinanceStatusChanged(
  app: {
    dealerId: number;
    customerId: number | null;
    customerName: string;
    amount: number;
    apr: number;
    lender: string | null;
  },
  status: string,
): void {
  fire("finance_status_changed", async () => {
    const c = await customerEmail(app.dealerId, app.customerId);
    if (!c.email) return;
    const base: TemplateData = {
      ...(c.name ? { name: c.name } : { name: app.customerName }),
      amount: money(app.amount),
      ...(app.lender ? { lender: app.lender } : {}),
      apr: `${app.apr}%`,
    };
    if (status === "submitted" || status === "under_review") {
      await send({
        dealerId: app.dealerId,
        template: "finance_processing",
        to: c.email,
        customerId: app.customerId,
        data: base,
      });
    } else if (status === "approved") {
      await send({
        dealerId: app.dealerId,
        template: "finance_approved",
        to: c.email,
        customerId: app.customerId,
        data: base,
      });
    }
  });
}

/**
 * Delivery advisor assigned → introduce the advisor to the customer.
 * Deduped per delivery+advisor so re-saving the same advisor never re-sends.
 */
export function onDeliveryAdvisorAssigned(opts: {
  dealerId: number;
  deliveryId: number;
  customerId: number | null;
  customerName: string | null;
  advisorUserId: number;
  vehicleLabel: string;
}): void {
  fire("delivery_advisor_assigned", async () => {
    const c = await customerEmail(opts.dealerId, opts.customerId);
    const to = c.email;
    if (!to) return;
    // Tenancy: only surface the advisor if they are a member of this dealership.
    const [advisor] = await db
      .select({ name: usersTable.name, email: usersTable.email })
      .from(usersTable)
      .innerJoin(
        dealerUsersTable,
        and(
          eq(dealerUsersTable.userId, usersTable.id),
          eq(dealerUsersTable.dealerId, opts.dealerId),
        ),
      )
      .where(eq(usersTable.id, opts.advisorUserId));
    if (!advisor) return;
    await enqueueEmail({
      dealerId: opts.dealerId,
      template: "delivery_advisor_assigned",
      to,
      customerId: opts.customerId,
      dedupeKey: `delivery_advisor_assigned:${opts.deliveryId}:${opts.advisorUserId}`,
      data: {
        name: c.name ?? opts.customerName ?? "",
        advisor: advisor.name ?? advisor.email ?? "your delivery advisor",
        vehicle: opts.vehicleLabel,
      },
    });
  });
}

/**
 * Delivery workflow completed (vehicle handed over) → celebration email.
 * Deduped per delivery; the deal-stage `delivered` hop no longer sends this
 * (delivery completion is the only path that sets that stage).
 */
export function onDeliveryCompleted(opts: {
  dealerId: number;
  deliveryId: number;
  customerId: number | null;
  customerName: string | null;
  vehicleLabel: string;
}): void {
  fire("delivery_completed", async () => {
    const c = await customerEmail(opts.dealerId, opts.customerId);
    if (!c.email) return;
    await enqueueEmail({
      dealerId: opts.dealerId,
      template: "delivery_confirmation",
      to: c.email,
      customerId: opts.customerId,
      dedupeKey: `delivery_confirmation:${opts.deliveryId}`,
      data: {
        name: c.name ?? opts.customerName ?? "",
        vehicle: opts.vehicleLabel,
      },
    });
  });
}

// ---------------------------------------------------------------------------
// FR-COM-01/02 — service milestone + feedback emails. Every send carries a
// dedupe key derived from the order id + milestone, so status churn (bouncing
// in/out of on_hold, repeated PATCHes) can never spam the customer.
// ---------------------------------------------------------------------------

const serviceDateLabel = (
  value: string | Date | null | undefined,
  tz: string,
): string => {
  if (!value) return "";
  return fullMonthDate(value, tz);
};

/** Service order created → request receipt (not a confirmed appointment). */
export function onServiceOrderBooked(order: ServiceOrder): void {
  fire("service_booking_received", async () => {
    const c = await customerEmail(order.dealerId, order.customerId);
    if (!c.email) return;
    const tz = await dealerTimezone(order.dealerId);
    const [dealer] = await db
      .select({ name: dealersTable.name })
      .from(dealersTable)
      .where(eq(dealersTable.id, order.dealerId));
    await enqueueEmail({
      dealerId: order.dealerId,
      template: "service.booking.received",
      to: c.email,
      customerId: order.customerId,
      dedupeKey: `svc:${order.id}:booked`,
      data: {
        ...(c.name ? { name: c.name } : {}),
        vehicle: order.vehicleInfo,
        service: order.type,
        date: serviceDateLabel(order.scheduledDate, tz),
        ...(dealer?.name ? { dealer: dealer.name } : {}),
      },
    });
  });
}

async function cancelServiceReminders(orderId: number, dealerId: number) {
  await db
    .update(emailLogsTable)
    .set({ status: "cancelled", nextAttemptAt: null })
    .where(
      and(
        eq(emailLogsTable.dealerId, dealerId),
        eq(emailLogsTable.status, "queued"),
        like(emailLogsTable.dedupeKey, `svc:${orderId}:reminder:%`),
      ),
    );
}

/** Cancel stale reminders, confirm an acknowledged appointment, and schedule 48h/3h. */
async function confirmServiceAppointment(order: ServiceOrder): Promise<void> {
  await cancelServiceReminders(order.id, order.dealerId);
  const c = await customerEmail(order.dealerId, order.customerId);
  if (!c.email) return;
  const [card] = await db
    .select()
    .from(jobCardsTable)
    .where(
      and(
        eq(jobCardsTable.serviceOrderId, order.id),
        eq(jobCardsTable.dealerId, order.dealerId),
      ),
    )
    .limit(1);
  if (!card?.scheduledAt) return;
  const [dealer] = await db
    .select({ name: dealersTable.name, address: dealersTable.address })
    .from(dealersTable)
    .where(eq(dealersTable.id, order.dealerId));
  const tz = await dealerTimezone(order.dealerId);
  const base: TemplateData = {
    ...(c.name ? { name: c.name } : {}),
    vehicle: order.vehicleInfo,
    service: order.type,
    date: serviceDateLabel(card.scheduledAt, tz),
    time: formatDealerTime(card.scheduledAt, tz),
    ...(card.technicianName ? { advisor: card.technicianName } : {}),
    ...(dealer?.address || dealer?.name
      ? { location: dealer.address || dealer.name }
      : {}),
    serviceOrderId: String(order.id),
    reminderScheduledAt: card.scheduledAt.toISOString(),
  };
  await enqueueEmail({
    dealerId: order.dealerId,
    template: "service.appointment.confirmed",
    to: c.email,
    customerId: order.customerId,
    dedupeKey: `svc:${order.id}:confirmed:${card.scheduledAt.getTime()}`,
    data: {
      ...base,
      ...serviceCalendarFields({
        orderId: order.id,
        startsAt: card.scheduledAt,
        durationMins: card.durationMins,
        vehicle: order.vehicleInfo,
        service: order.type,
        customerEmail: c.email,
        customerName: c.name,
        advisor: card.technicianName,
        location: dealer?.address || dealer?.name,
      }),
    },
  });
  for (const [hours, window] of [[48, "In 48 hours"], [3, "In 3 hours"]] as const) {
    const sendAt = new Date(card.scheduledAt.getTime() - hours * 60 * 60 * 1000);
    if (sendAt.getTime() <= Date.now()) continue;
    await enqueueEmail({
      dealerId: order.dealerId,
      template: "service.appointment.reminder",
      to: c.email,
      customerId: order.customerId,
      dedupeKey: `svc:${order.id}:reminder:${hours}h:${card.scheduledAt.getTime()}`,
      sendAt,
      data: { ...base, window },
    });
  }
}

export function onServiceAppointmentChanged(order: ServiceOrder): void {
  fire("service_appointment_changed", () => confirmServiceAppointment(order));
}

/** First persisted job-card intake → digital check-in receipt. */
export function onJobCardIntakeRecorded(order: ServiceOrder, card: JobCard): void {
  fire("service_checkin", async () => {
    const c = await customerEmail(order.dealerId, order.customerId);
    if (!c.email || !card.intake) return;
    const condition = [
      card.intake.fuelLevel ? `fuel ${card.intake.fuelLevel}` : "",
      card.intake.notes || "",
    ].filter(Boolean).join("; ");
    await enqueueEmail({
      dealerId: order.dealerId,
      template: "service.checkin.receipt",
      to: c.email,
      customerId: order.customerId,
      dedupeKey: `svc:${order.id}:checkin`,
      data: {
        ...(c.name ? { name: c.name } : {}),
        vehicle: order.vehicleInfo,
        concerns: order.complaint || card.title,
        ...(card.intake.odometer != null
          ? { mileage: `${card.intake.odometer.toLocaleString("en-US")} km` }
          : order.odometer != null
            ? { mileage: `${order.odometer.toLocaleString("en-US")} km` }
            : {}),
        ...(condition ? { condition } : {}),
        ...(card.technicianName ? { advisor: card.technicianName } : {}),
      },
    });
  });
}

/** Quote total first becomes available → secure whole-estimate decision link. */
export function onServiceEstimateReady(order: ServiceOrder, card: JobCard): void {
  fire("service_estimate_ready", async () => {
    if (card.quoteTotal <= 0) return;
    const c = await customerEmail(order.dealerId, order.customerId);
    if (!c.email) return;
    const [existing] = await db
      .select({ id: serviceEstimateDecisionsTable.id })
      .from(serviceEstimateDecisionsTable)
      .where(
        and(
          eq(serviceEstimateDecisionsTable.dealerId, order.dealerId),
          eq(serviceEstimateDecisionsTable.jobCardId, card.id),
          isNull(serviceEstimateDecisionsTable.decision),
          isNull(serviceEstimateDecisionsTable.invalidatedAt),
        ),
      )
      .limit(1);
    if (existing) return;
    const parts = await db
      .select()
      .from(jobCardPartsTable)
      .where(
        and(
          eq(jobCardPartsTable.dealerId, order.dealerId),
          eq(jobCardPartsTable.jobCardId, card.id),
        ),
      )
      .orderBy(jobCardPartsTable.id);
    const lines: ServiceEstimateLine[] = parts
      .filter((p) => p.kind === "issue")
      .map((p) => ({
        kind: "part",
        description: p.partName,
        quantity: p.quantity,
        amount: p.quantity * p.unitPrice,
      }));
    if (card.laborHours > 0) {
      lines.push({
        kind: "labour",
        description: "Labour",
        quantity: card.laborHours,
        amount: card.laborHours * card.laborRate,
      });
    }
    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await db.insert(serviceEstimateDecisionsTable).values({
      dealerId: order.dealerId,
      serviceOrderId: order.id,
      jobCardId: card.id,
      tokenHash,
      estimateTotal: card.quoteTotal,
      linesSnapshot: lines,
      expiresAt,
    });
    const origin = publicAppOrigin();
    if (!origin) return;
    await enqueueEmail({
      dealerId: order.dealerId,
      template: "service.estimate.ready",
      to: c.email,
      customerId: order.customerId,
      dedupeKey: `svc:${order.id}:estimate:${card.id}:${card.quoteTotal}`,
      data: {
        vehicle: order.vehicleInfo,
        total: money(card.quoteTotal),
        expires: expiresAt.toISOString().slice(0, 10),
        link: `${origin}/service-estimate/${token}`,
      },
    });
  });
}

/**
 * Service invoice issued (work completed) → email the customer the invoice
 * with the branded PDF attached. Deduped per invoice, so a manual "Generate
 * invoice" click after an auto-issue never sends twice.
 */
export function onServiceInvoiceIssued(invoice: ServiceInvoice): void {
  fire("service_invoice_issued", async () => {
    const c = await customerEmail(invoice.dealerId, invoice.customerId);
    if (!c.email) return;
    const [card] = await db
      .select({
        workPerformed: jobCardsTable.workPerformed,
        serviceAnalysis: jobCardsTable.serviceAnalysis,
        notes: jobCardsTable.notes,
      })
      .from(jobCardsTable)
      .where(
        and(
          eq(jobCardsTable.id, invoice.jobCardId),
          eq(jobCardsTable.dealerId, invoice.dealerId),
        ),
      );
    await enqueueEmail({
      dealerId: invoice.dealerId,
      template: "service.invoice.issued",
      to: c.email,
      customerId: invoice.customerId,
      dedupeKey: `svcinv:${invoice.id}:issued`,
      data: {
        ...(c.name ? { name: c.name } : {}),
        vehicle: invoice.vehicleInfo ?? "",
        invoiceRef: `SV-${String(invoice.id).padStart(5, "0")}`,
        total: money(invoice.total),
        serviceInvoiceId: String(invoice.id),
        ...(card?.workPerformed
          ? { completedWork: card.workPerformed }
          : {}),
        ...(card?.notes || card?.serviceAnalysis
          ? { recommendedMaintenance: card.notes || card.serviceAnalysis || "" }
          : {}),
      },
    });
  });
}

/**
 * Service order status transitions → customer milestone emails:
 * in_progress = work started, on_hold = paused/awaiting parts,
 * resolved = ready for pickup, closed = feedback request.
 */
export function onServiceOrderStatusChanged(
  before: ServiceOrder,
  after: ServiceOrder,
): void {
  if (before.status === after.status) return;
  fire("service_order_status_changed", async () => {
    const c = await customerEmail(after.dealerId, after.customerId);
    if (!c.email) return;
    const base: TemplateData = {
      ...(c.name ? { name: c.name } : {}),
      vehicle: after.vehicleInfo,
      service: after.type,
    };
    switch (after.status) {
      case "acknowledged":
        await confirmServiceAppointment(after);
        break;
      case "in_progress":
        await cancelServiceReminders(after.id, after.dealerId);
        // Re-entering in_progress after on_hold dedupes to the first send.
        await enqueueEmail({
          dealerId: after.dealerId,
          template: "service.started",
          to: c.email,
          customerId: after.customerId,
          dedupeKey: `svc:${after.id}:started`,
          data: base,
        });
        break;
      case "on_hold":
        await cancelServiceReminders(after.id, after.dealerId);
        await enqueueEmail({
          dealerId: after.dealerId,
          template: "service.delayed",
          to: c.email,
          customerId: after.customerId,
          dedupeKey: `svc:${after.id}:delayed`,
          data: { ...base, reason: "we're waiting on a part or workshop slot" },
        });
        break;
      case "resolved":
        await cancelServiceReminders(after.id, after.dealerId);
        const [readyInvoice] = await db
          .select({ total: serviceInvoicesTable.total })
          .from(serviceInvoicesTable)
          .where(
            and(
              eq(serviceInvoicesTable.serviceOrderId, after.id),
              eq(serviceInvoicesTable.dealerId, after.dealerId),
            ),
          )
          .limit(1);
        await enqueueEmail({
          dealerId: after.dealerId,
          template: "vehicle_ready",
          to: c.email,
          customerId: after.customerId,
          dedupeKey: `svc:${after.id}:ready`,
          data: {
            ...base,
            ...(readyInvoice ? { balance: money(readyInvoice.total) } : {}),
          },
        });
        break;
      case "closed":
        await cancelServiceReminders(after.id, after.dealerId);
        // A service invitation is deliberately customer/order-bound (not
        // lead-bound). Store only its digest and schedule the existing branded
        // feedback email after collection, never immediately on closure.
        const origin = publicAppOrigin();
        if (!origin || after.customerId == null) break;
        const [existingInvitation] = await db
          .select({ id: feedbackInvitationsTable.id })
          .from(feedbackInvitationsTable)
          .where(
            and(
              eq(feedbackInvitationsTable.dealerId, after.dealerId),
              eq(feedbackInvitationsTable.serviceOrderId, after.id),
            ),
          )
          .limit(1);
        if (existingInvitation) break;
        const feedbackToken = randomBytes(32).toString("base64url");
        const feedbackHash = createHash("sha256")
          .update(feedbackToken)
          .digest("hex");
        const feedbackExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        const [invitation] = await db
          .insert(feedbackInvitationsTable)
          .values({
            dealerId: after.dealerId,
            formId: 0,
            leadId: null,
            serviceOrderId: after.id,
            customerId: after.customerId,
            vehicleLabel: after.vehicleInfo,
            token: null,
            tokenHash: feedbackHash,
            formName: "Your service feedback",
            questionsSnapshot: [
              { id: "rating", type: "star_rating", label: "How would you rate your service experience?", required: true, maxStars: 5 },
              { id: "comment", type: "long_text", label: "Is there anything else you would like us to know?", required: false },
            ],
            expiresAt: feedbackExpiresAt,
            channels: ["email"],
            createdBy: "Service lifecycle",
          })
          .onConflictDoNothing()
          .returning({ id: feedbackInvitationsTable.id });
        if (!invitation) break;
        await enqueueEmail({
          dealerId: after.dealerId,
          template: "feedback.survey",
          to: c.email,
          customerId: after.customerId,
          dedupeKey: `csat:service_order:${after.id}:email`,
          data: {
            ...(c.name ? { name: c.name } : {}),
            context: `your recent ${after.type} service on the ${after.vehicleInfo}`,
            link: `${origin}/feedback/${feedbackToken}`,
          },
          sendAt: new Date(Date.now() + 36 * 60 * 60 * 1000),
        });
        break;
      case "cancelled":
        await cancelServiceReminders(after.id, after.dealerId);
        break;
    }
  });
}

/**
 * Job-card rollover fully signed off → tell the customer their job carries
 * over to another day. Deduped per card + target date.
 */
export function onJobCardRolloverApproved(opts: {
  dealerId: number;
  jobCardId: number;
  serviceOrderId: number;
  customerId: number | null;
  vehicleInfo: string;
  serviceType: string;
  toDate: string | null;
  reason?: string | null;
}): void {
  fire("service_rollover_approved", async () => {
    const c = await customerEmail(opts.dealerId, opts.customerId);
    if (!c.email) return;
    const tz = await dealerTimezone(opts.dealerId);
    await enqueueEmail({
      dealerId: opts.dealerId,
      template: "service.delayed",
      to: c.email,
      customerId: opts.customerId,
      dedupeKey: `svc:${opts.serviceOrderId}:delayed:rollover:${opts.jobCardId}:${opts.toDate ?? "tbd"}`,
      data: {
        ...(c.name ? { name: c.name } : {}),
        vehicle: opts.vehicleInfo,
        service: opts.serviceType,
        reason: opts.reason?.trim() || "the work is carrying over to another day",
        ...(opts.toDate ? { newDate: serviceDateLabel(opts.toDate, tz) } : {}),
      },
    });
  });
}
