import { eq, inArray } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import {
  enqueueEmail,
  enqueueWhatsapp,
  notifyUser,
  notifyUsers,
  type TemplateData,
} from "./email";
import { dealerTimezone, formatDealerDateTime } from "./timezone";
import {
  divisionSalesManagers,
  financeUsers,
  reportingManagersOf,
  serviceUsers,
  usersWithPermission,
} from "./notify-matrix";
import { logger } from "./logger";

/**
 * R6.2 trigger fan-out helpers. Each function implements one row of the
 * notification matrix: In-App is the transaction-adjacent primary channel
 * (natural-key dedupe), Email/WhatsApp ride the outbox with the trigger's
 * canonical dedupeKey. All are fire-and-forget — a notification hiccup never
 * fails the originating request.
 */

function fire(label: string, fn: () => Promise<void>): void {
  void fn().catch((err) => {
    logger.error({ err, trigger: label }, "notification trigger failed");
  });
}

/** Work emails of internal users (for the supplementary Email channel). */
async function userEmails(userIds: number[]): Promise<Map<number, string>> {
  if (userIds.length === 0) return new Map();
  const rows = await db
    .select({ id: usersTable.id, email: usersTable.email })
    .from(usersTable)
    .where(inArray(usersTable.id, userIds));
  return new Map(
    rows.filter((r) => r.email).map((r) => [r.id, r.email] as [number, string]),
  );
}

/** In-App (primary) + Email (outbox) fan-out to a set of internal users. */
export async function notifyInternal(opts: {
  dealerId: number;
  userIds: number[];
  type: Parameters<typeof notifyUser>[0]["type"];
  template: Parameters<typeof enqueueEmail>[0]["template"];
  title: string;
  body: string;
  link: string;
  entityType: string;
  entityId: number;
  dedupeKey: string;
  data?: TemplateData;
  /** Skip the email leg (In-App only rows of the matrix). */
  inAppOnly?: boolean;
}): Promise<void> {
  const ids = [...new Set(opts.userIds)];
  if (ids.length === 0) return;
  await notifyUsers(ids, {
    dealerId: opts.dealerId,
    type: opts.type,
    title: opts.title,
    body: opts.body,
    link: opts.link,
    entityType: opts.entityType,
    entityId: opts.entityId,
  });
  if (opts.inAppOnly) return;
  const emails = await userEmails(ids);
  for (const id of ids) {
    const to = emails.get(id);
    if (!to) continue;
    await enqueueEmail({
      template: opts.template,
      to,
      dealerId: opts.dealerId,
      data: { title: opts.title, body: opts.body, ...(opts.data ?? {}) },
      dedupeKey: `${opts.dedupeKey}:u${id}`,
    });
  }
}

// ---------------------------------------------------------------------------
// MRQ low-stock alert → parts staff (In-App only). Callers fire this only when
// stock CROSSES from above to at-or-below the reorder level, and the in-app
// natural key (dealer, user, type, part) upserts — so it never spams a bell
// per issuance.
// ---------------------------------------------------------------------------
export function notifyPartLowStock(part: {
  id: number;
  dealerId: number;
  sku: string;
  name: string;
  stock: number;
  reorderLevel: number;
}): void {
  fire("part.low_stock", async () => {
    let users = await usersWithPermission(part.dealerId, "parts");
    if (users.length === 0) users = await serviceUsers(part.dealerId);
    if (users.length === 0) return;
    await notifyUsers(users, {
      dealerId: part.dealerId,
      type: "part.low_stock",
      title: `Low stock — ${part.name}`,
      body: `${part.sku}: ${part.stock} on hand, at or below the reorder level of ${part.reorderLevel}. Raise a purchase order.`,
      link: "/parts",
      entityType: "part",
      entityId: part.id,
    });
  });
}

// ---------------------------------------------------------------------------
// #1 New Lead → division sales managers (In-App + Email), key lead:new:{id}
// ---------------------------------------------------------------------------
export function notifyLeadNew(lead: {
  id: number;
  dealerId: number;
  divisionId: number | null;
  name: string;
  source: string | null;
}): void {
  fire("lead.new", async () => {
    const managers = await divisionSalesManagers(lead.dealerId, lead.divisionId);
    await notifyInternal({
      dealerId: lead.dealerId,
      userIds: managers,
      type: "lead.new",
      template: "lead.new",
      title: `New lead — ${lead.name}`,
      body: `A new lead arrived${lead.source ? ` via ${lead.source}` : ""} and is awaiting assignment.`,
      link: `/pipeline/${lead.id}`,
      entityType: "lead",
      entityId: lead.id,
      dedupeKey: `lead:new:${lead.id}`,
      data: { name: lead.name, source: lead.source ?? "" },
    });
  });
}

// ---------------------------------------------------------------------------
// #2 Assigned Lead → advisor (In-App + Email), key lead:assigned:{id}:{userId}
// ---------------------------------------------------------------------------
export function notifyLeadAssigned(lead: {
  id: number;
  dealerId: number;
  name: string;
  ownerUserId: number | null;
}): void {
  if (!lead.ownerUserId) return;
  const advisorId = lead.ownerUserId;
  fire("lead.assigned", async () => {
    await notifyInternal({
      dealerId: lead.dealerId,
      userIds: [advisorId],
      type: "lead.assigned",
      template: "lead.assigned",
      title: `Lead assigned to you — ${lead.name}`,
      body: "You are now the owner. First contact is due within 48 hours.",
      link: `/pipeline/${lead.id}`,
      entityType: "lead",
      entityId: lead.id,
      dedupeKey: `lead:assigned:${lead.id}:${advisorId}`,
      data: { name: lead.name },
    });
  });
}

// ---------------------------------------------------------------------------
// #6 Reservation Pending → customer (WA + Email) + advisor (In-App),
//    key booking:pending:{bookingId} (+ :remind:{n} for nudges)
// ---------------------------------------------------------------------------
export function notifyReservationPending(opts: {
  bookingId: number;
  dealerId: number;
  customerId?: number | null;
  leadId?: number | null;
  customerName: string;
  customerEmail?: string | null;
  customerPhone?: string | null;
  vehicle: string;
  amount: string;
  expiresAt?: Date | null;
  advisorUserId?: number | null;
  /** Nudge index for repeat reminders (0 = initial). */
  remindIndex?: number;
}): void {
  fire("reservation.pending", async () => {
    const tz = await dealerTimezone(opts.dealerId);
    const base = `booking:pending:${opts.bookingId}`;
    const key = opts.remindIndex ? `${base}:remind:${opts.remindIndex}` : base;
    const data: TemplateData = {
      name: opts.customerName,
      vehicle: opts.vehicle,
      amount: opts.amount,
      ...(opts.expiresAt
        ? { expires: formatDealerDateTime(opts.expiresAt, tz) }
        : {}),
    };
    if (opts.customerEmail) {
      await enqueueEmail({
        template: "reservation.pending",
        to: opts.customerEmail,
        dealerId: opts.dealerId,
        customerId: opts.customerId,
        leadId: opts.leadId,
        data,
        dedupeKey: `${key}:email`,
        notifyUserId: opts.advisorUserId ?? undefined,
      });
    }
    if (opts.customerPhone) {
      await enqueueWhatsapp({
        kind: "reservation.pending",
        to: opts.customerPhone,
        dealerId: opts.dealerId,
        customerId: opts.customerId,
        leadId: opts.leadId,
        summary: `Reservation pending — ${opts.vehicle}`,
        body: `Hello ${opts.customerName}, your reservation for the ${opts.vehicle} is being held. Please complete the reservation payment of ${opts.amount}${opts.expiresAt ? ` before ${data.expires}` : ""} to secure the vehicle. Your advisor can assist with payment instructions.`,
        dedupeKey: `${key}:whatsapp`,
        fallbackEmail: opts.customerEmail
          ? { to: opts.customerEmail, template: "reservation.pending", data }
          : undefined,
        notifyUserId: opts.advisorUserId ?? undefined,
      });
    }
    if (opts.advisorUserId) {
      await notifyUser({
        dealerId: opts.dealerId,
        userId: opts.advisorUserId,
        type: "reservation.pending",
        title: `Reservation pending — ${opts.customerName}`,
        body: `${opts.vehicle}: reservation fee ${opts.amount} not yet received${opts.expiresAt ? `, hold expires ${data.expires}` : ""}.`,
        link: "/inventory",
        entityType: "booking",
        entityId: opts.bookingId,
      });
    }
  });
}

// ---------------------------------------------------------------------------
// #9 Cancellation → advisor's reporting manager + division managers
//    (In-App + Email), key cancel:{entityType}:{entityId}
// ---------------------------------------------------------------------------
export function notifyCancellation(opts: {
  dealerId: number;
  entityType: "booking" | "deal" | "service_order";
  entityId: number;
  label: string;
  reason?: string | null;
  advisorUserId?: number | null;
  divisionId?: number | null;
}): void {
  fire("cancellation.manager", async () => {
    const managers = new Set<number>();
    if (opts.advisorUserId) {
      for (const id of await reportingManagersOf(opts.dealerId, opts.advisorUserId))
        managers.add(id);
    }
    for (const id of await divisionSalesManagers(opts.dealerId, opts.divisionId ?? null))
      managers.add(id);
    const kindLabel = opts.entityType.replace(/_/g, " ");
    await notifyInternal({
      dealerId: opts.dealerId,
      userIds: [...managers],
      type: "cancellation.manager",
      template: "cancellation.manager",
      title: `Cancellation — ${opts.label}`,
      body: `A ${kindLabel} was cancelled${opts.reason ? `. Reason: ${opts.reason}` : "."}`,
      link:
        opts.entityType === "service_order"
          ? "/service"
          : opts.entityType === "deal"
            ? "/deals"
            : "/inventory",
      entityType: opts.entityType,
      entityId: opts.entityId,
      dedupeKey: `cancel:${opts.entityType}:${opts.entityId}`,
      data: { label: opts.label, reason: opts.reason ?? "" },
    });
  });
}

// ---------------------------------------------------------------------------
// #10 Approved-for-Refund → finance/AP (payments edit), key refund:approved:{gateId}
// ---------------------------------------------------------------------------
export function notifyRefundApproved(opts: {
  dealerId: number;
  gateId: number;
  label: string;
  amount?: string;
}): void {
  fire("refund.approved.finance", async () => {
    const users = await usersWithPermission(opts.dealerId, "finance", [
      "edit",
      "admin",
    ]);
    const fallback = users.length > 0 ? users : await financeUsers(opts.dealerId);
    await notifyInternal({
      dealerId: opts.dealerId,
      userIds: fallback,
      type: "refund.approved.finance",
      template: "refund.approved.finance",
      title: `Refund approved — ${opts.label}`,
      body: `A refund release gate was approved${opts.amount ? ` for ${opts.amount}` : ""}. Post the refund to the ledger.`,
      link: "/finance",
      entityType: "gate",
      entityId: opts.gateId,
      dedupeKey: `refund:approved:${opts.gateId}`,
      data: { label: opts.label, amount: opts.amount ?? "" },
    });
  });
}

// ---------------------------------------------------------------------------
// #11 Refund → customer (Email + WhatsApp), key refund:paid:{paymentId}
// ---------------------------------------------------------------------------
export function notifyRefundPaid(opts: {
  dealerId: number;
  paymentId: number;
  customerId?: number | null;
  customerName: string;
  customerEmail?: string | null;
  customerPhone?: string | null;
  amount: string;
  reference: string;
  vehicle?: string;
  advisorUserId?: number | null;
}): void {
  fire("refund.customer", async () => {
    const key = `refund:paid:${opts.paymentId}`;
    const data: TemplateData = {
      name: opts.customerName,
      amount: opts.amount,
      reference: opts.reference,
      ...(opts.vehicle ? { vehicle: opts.vehicle } : {}),
    };
    if (opts.customerEmail) {
      await enqueueEmail({
        template: "refund.customer",
        to: opts.customerEmail,
        dealerId: opts.dealerId,
        customerId: opts.customerId,
        data,
        dedupeKey: `${key}:email`,
        notifyUserId: opts.advisorUserId ?? undefined,
      });
    }
    if (opts.customerPhone) {
      await enqueueWhatsapp({
        kind: "refund.customer",
        to: opts.customerPhone,
        dealerId: opts.dealerId,
        customerId: opts.customerId,
        summary: `Refund processed — ${opts.reference}`,
        body: `Hello ${opts.customerName}, your refund of ${opts.amount} (ref ${opts.reference}) has been processed. It should reflect according to your bank's timelines. Thank you for your patience.`,
        dedupeKey: `${key}:whatsapp`,
        fallbackEmail: opts.customerEmail
          ? { to: opts.customerEmail, template: "refund.customer", data }
          : undefined,
        notifyUserId: opts.advisorUserId ?? undefined,
      });
    }
  });
}

// ---------------------------------------------------------------------------
// #12 Delivery-Ready → delivery advisor + sales advisor (In-App + Email),
//     key delivery:ready:{deliveryId}
// ---------------------------------------------------------------------------
export function notifyDeliveryReady(opts: {
  dealerId: number;
  deliveryId: number;
  customerName: string;
  vehicle: string;
  advisorUserIds: number[];
}): void {
  fire("delivery.ready", async () => {
    await notifyInternal({
      dealerId: opts.dealerId,
      userIds: opts.advisorUserIds,
      type: "delivery.ready",
      template: "delivery.ready",
      title: `Delivery ready — ${opts.customerName}`,
      body: `${opts.vehicle} has cleared invoice and appointment steps and is ready for handover.`,
      link: `/deliveries/${opts.deliveryId}`,
      entityType: "delivery",
      entityId: opts.deliveryId,
      dedupeKey: `delivery:ready:${opts.deliveryId}`,
      data: { name: opts.customerName, vehicle: opts.vehicle },
    });
  });
}

// ---------------------------------------------------------------------------
// #13 Delivered → service handoff (In-App + Email), key asset:delivered:{assetId}
// ---------------------------------------------------------------------------
export function notifyDeliveredServiceHandoff(opts: {
  dealerId: number;
  assetId: number;
  customerName: string;
  vehicle: string;
  serviceAdvisorUserId?: number | null;
}): void {
  fire("delivered.service.handoff", async () => {
    const users = opts.serviceAdvisorUserId
      ? [opts.serviceAdvisorUserId]
      : await serviceUsers(opts.dealerId);
    await notifyInternal({
      dealerId: opts.dealerId,
      userIds: users,
      type: "delivered.service.handoff",
      template: "delivered.service.handoff",
      title: `Vehicle delivered — service handoff`,
      body: `${opts.vehicle} was delivered to ${opts.customerName}. The service cadence baseline starts now.`,
      link: "/service",
      entityType: "asset",
      entityId: opts.assetId,
      dedupeKey: `asset:delivered:${opts.assetId}`,
      data: { name: opts.customerName, vehicle: opts.vehicle },
    });
  });
}

// ---------------------------------------------------------------------------
// #14 Case Open → service manager + assigned advisor (In-App + Email),
//     key case:open:{caseId}
// ---------------------------------------------------------------------------
export function notifyCaseOpened(opts: {
  dealerId: number;
  caseId: number;
  title: string;
  customerName?: string | null;
  serviceAdvisorUserId?: number | null;
}): void {
  fire("case.opened", async () => {
    const users = new Set<number>(await serviceUsers(opts.dealerId));
    if (opts.serviceAdvisorUserId) users.add(opts.serviceAdvisorUserId);
    await notifyInternal({
      dealerId: opts.dealerId,
      userIds: [...users],
      type: "case.opened",
      template: "case.opened",
      title: `Case opened — ${opts.title}`,
      body: `${opts.customerName ? `${opts.customerName}: ` : ""}a new case needs attention.`,
      link: "/service",
      entityType: "case",
      entityId: opts.caseId,
      dedupeKey: `case:open:${opts.caseId}`,
      data: { title: opts.title, name: opts.customerName ?? "" },
    });
  });
}

// ---------------------------------------------------------------------------
// #15 Manager note → advisor (In-App; Email only when flagged urgent),
//     key note:{noteId}:{advisorUserId}
// ---------------------------------------------------------------------------
export function notifyManagerNote(opts: {
  dealerId: number;
  noteId: number;
  advisorUserId: number;
  authorName: string;
  excerpt: string;
  link: string;
  urgent?: boolean;
}): void {
  fire("manager.note.advisor", async () => {
    await notifyInternal({
      dealerId: opts.dealerId,
      userIds: [opts.advisorUserId],
      type: "manager.note.advisor",
      template: "manager.note.advisor",
      title: `Note from ${opts.authorName}`,
      body: opts.excerpt,
      link: opts.link,
      entityType: "note",
      entityId: opts.noteId,
      dedupeKey: `note:${opts.noteId}:${opts.advisorUserId}`,
      inAppOnly: !opts.urgent,
      data: { author: opts.authorName, note: opts.excerpt },
    });
  });
}

// ---------------------------------------------------------------------------
// #16 Feedback Survey → customer (WhatsApp + Email), key csat:{entityType}:{entityId}
// ---------------------------------------------------------------------------
export function notifyFeedbackSurvey(opts: {
  dealerId: number;
  entityType: "delivery" | "service_order";
  entityId: number;
  customerId?: number | null;
  customerName: string;
  customerEmail?: string | null;
  customerPhone?: string | null;
  vehicle?: string | null;
  advisorUserId?: number | null;
}): void {
  fire("feedback.survey", async () => {
    const key = `csat:${opts.entityType}:${opts.entityId}`;
    const data: TemplateData = {
      name: opts.customerName,
      ...(opts.vehicle ? { vehicle: opts.vehicle } : {}),
    };
    if (opts.customerEmail) {
      await enqueueEmail({
        template: "feedback.survey",
        to: opts.customerEmail,
        dealerId: opts.dealerId,
        customerId: opts.customerId,
        data,
        dedupeKey: `${key}:email`,
        notifyUserId: opts.advisorUserId ?? undefined,
      });
    }
    if (opts.customerPhone) {
      await enqueueWhatsapp({
        kind: "feedback.survey",
        to: opts.customerPhone,
        dealerId: opts.dealerId,
        customerId: opts.customerId,
        summary: "How did we do?",
        body: `Hello ${opts.customerName}, thank you for choosing AURA${opts.vehicle ? ` for your ${opts.vehicle}` : ""}. We'd love your feedback — simply reply to this message with a rating from 1 to 5 and any comments.`,
        dedupeKey: `${key}:whatsapp`,
        fallbackEmail: opts.customerEmail
          ? { to: opts.customerEmail, template: "feedback.survey", data }
          : undefined,
        notifyUserId: opts.advisorUserId ?? undefined,
      });
    }
  });
}
