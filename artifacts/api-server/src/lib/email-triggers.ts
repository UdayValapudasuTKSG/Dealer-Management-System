import { and, eq } from "drizzle-orm";
import {
  db,
  customersTable,
  deliveriesTable,
  vehiclesTable,
  type Lead,
  type Deal,
  type ServiceOrder,
  usersTable,
  dealerUsersTable,
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
import { ownerCalendarContact, testDriveCalendarFields } from "./calendar";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Lifecycle email triggers — fire-and-forget, never fail the request
// ---------------------------------------------------------------------------

const money = (n: number) =>
  `GY$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

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

const longDate = (d: Date) =>
  d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

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
    } else {
      const label = `${v.make} ${v.model}`;
      const version =
        v.trim || v.variant || lead.variant || "Standard specification";
      const color = v.exteriorColor || lead.color || "";
      const quantity = 1;
      const now = new Date();
      const validUntil = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
      // Booking CTA rides along inside the quote email too, so the customer
      // can reserve a slot even if the separate invite email is missed.
      const bookingLink = lead.testDriveAt
        ? null
        : testDriveBookingUrl(lead.testDriveToken);

      await send({
        dealerId: lead.dealerId,
        template: "vehicle_quote",
        to,
        customerId: lead.customerId,
        data: {
          name,
          vehicle: label,
          model: v.model,
          version,
          color,
          quantity: String(quantity),
          unitPrice: money(v.price),
          total: money(v.price * quantity),
          quoteRef: `Q-${lead.id}-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`,
          issuedOn: longDate(now),
          validUntil: longDate(validUntil),
          ...(bookingLink ? { link: bookingLink } : {}),
        },
      });
    }

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
  // Dealership policy: no customer self-scheduling — the invite carries the
  // assigned sales advisor's phone number for a follow-up call instead.
  const advisor = await leadAdvisorContact(lead);
  const vehicle = await vehicleName(lead.dealerId, lead.interestedVehicleId);
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
                date: after.testDriveAt.toLocaleDateString("en-US", {
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                }),
                time: after.testDriveAt.toLocaleTimeString("en-US", {
                  hour: "numeric",
                  minute: "2-digit",
                }),
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

const serviceDateLabel = (value: string | Date | null | undefined): string => {
  if (!value) return "";
  const iso = value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
  const parsed = new Date(`${iso}T12:00:00`);
  return Number.isNaN(parsed.getTime()) ? iso : longDate(parsed);
};

/** Service order created → booking confirmation. */
export function onServiceOrderBooked(order: ServiceOrder): void {
  fire("service_booking_confirmed", async () => {
    const c = await customerEmail(order.dealerId, order.customerId);
    if (!c.email) return;
    await enqueueEmail({
      dealerId: order.dealerId,
      template: "service.booking.confirmed",
      to: c.email,
      customerId: order.customerId,
      dedupeKey: `svc:${order.id}:booked`,
      data: {
        ...(c.name ? { name: c.name } : {}),
        vehicle: order.vehicleInfo,
        service: order.type,
        date: serviceDateLabel(order.scheduledDate),
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
      case "in_progress":
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
        await enqueueEmail({
          dealerId: after.dealerId,
          template: "vehicle_ready",
          to: c.email,
          customerId: after.customerId,
          dedupeKey: `svc:${after.id}:ready`,
          data: base,
        });
        break;
      case "closed":
        // FR-COM-02: post-service feedback request. The dedupe key matches
        // notifyFeedbackSurvey's email leg exactly (`csat:{entityType}:{id}:email`),
        // so if any other code path also fires a feedback survey for this
        // service order, the customer still receives at most one email.
        await enqueueEmail({
          dealerId: after.dealerId,
          template: "feedback.survey",
          to: c.email,
          customerId: after.customerId,
          dedupeKey: `csat:service_order:${after.id}:email`,
          data: {
            ...(c.name ? { name: c.name } : {}),
            context: `your recent ${after.type} service on the ${after.vehicleInfo}`,
          },
        });
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
        ...(opts.toDate ? { newDate: serviceDateLabel(opts.toDate) } : {}),
      },
    });
  });
}
