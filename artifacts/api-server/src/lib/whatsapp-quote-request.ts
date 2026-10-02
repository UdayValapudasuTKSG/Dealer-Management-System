import { and, desc, eq, sql } from "drizzle-orm";
import { db, leadsTable, quotesTable, tasksTable, timelineEventsTable, leadVehicleInterestsTable, vehiclesTable } from "@workspace/db";
import { enqueueEmail, notifyUser, preflightDealerEmailSender } from "./email";
import { generateQuoteForLead, quotePdfPayload } from "./quotes";
import { normalizeWhatsappPhone } from "./whatsapp-phone";
import { logger } from "./logger";

export const QUOTE_REPLIES = {
  queued: "Your detailed quote has been queued for email. It has not been confirmed sent yet.",
  sent: "This quote was already sent by email. Please check your inbox and spam folder.",
  handoff: "I've recorded a quote follow-up for our sales team. The quote has not been sent yet.",
  missing: "Please share your name and vehicle of interest so I can create your enquiry first.",
  email: "What email address should I use for your detailed quote?",
  failed: "I couldn't confirm a quote or a staff follow-up right now. Please try again or contact the sales team directly.",
} as const;

/** Only active sends are described as queued; failed/terminal rows need staff attention. */
export function quoteEmailReply(status: string): string | null {
  if (status === "sent") return QUOTE_REPLIES.sent;
  if (status === "queued" || status === "sending") return QUOTE_REPLIES.queued;
  return null;
}

export function confirmedQuoteReply(reply: string, confirmed?: string): string {
  if (confirmed) return confirmed;
  if (/\b(quote|quotation|estimate)\b/i.test(reply) &&
    /\b(sent|sending|queued|emailed|will\s+(?:\w+\s+){0,3}(?:send|email)|send\s+.{0,40}(?:shortly|soon))\b/i.test(reply)) {
    return "Would you like me to prepare a detailed quote? Please confirm the vehicle and the email address to use.";
  }
  return reply;
}

const quoteServices = {
  generate: generateQuoteForLead, enqueue: enqueueEmail,
  preflight: preflightDealerEmailSender, payload: quotePdfPayload,
};

/** No model-supplied IDs, price, recipient, discount or tax overrides. */
export async function requestWhatsappQuote(
  dealerId: number, leadId: number, phone: string, services = quoteServices,
): Promise<string> {
  const [lead] = await db.select().from(leadsTable).where(and(
    eq(leadsTable.id, leadId), eq(leadsTable.dealerId, dealerId),
  ));
  if (!lead || !normalizeWhatsappPhone(phone) ||
    normalizeWhatsappPhone(lead.phone ?? "") !== normalizeWhatsappPhone(phone)) return QUOTE_REPLIES.missing;
  if (!lead.email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(lead.email)) return QUOTE_REPLIES.email;
  let reason = "Quote preparation or delivery needs staff review.";
  try {
    const [latest] = await db.select().from(quotesTable).where(and(
      eq(quotesTable.dealerId, dealerId), eq(quotesTable.leadId, lead.id),
    )).orderBy(desc(quotesTable.version)).limit(1);
    const interests = await db.select().from(leadVehicleInterestsTable).where(and(
      eq(leadVehicleInterestsTable.dealerId, dealerId), eq(leadVehicleInterestsTable.leadId, lead.id),
    ));
    const [vehicle] = lead.interestedVehicleId ? await db.select().from(vehiclesTable).where(and(
      eq(vehiclesTable.dealerId, dealerId), eq(vehiclesTable.id, lead.interestedVehicleId),
    )) : [];
    // A changed conversational interest must never send an old multi-vehicle/spec quote.
    const interestMismatch = interests.length > 0 && (!vehicle || interests.length !== 1 ||
      interests[0].make !== vehicle.make || interests[0].model !== vehicle.model ||
      interests[0].modelYear !== vehicle.year || interests[0].unitPrice !== vehicle.price ||
      (interests[0].variant && interests[0].variant !== (vehicle.trim ?? vehicle.variant)) ||
      (interests[0].color && interests[0].color !== vehicle.exteriorColor));
    const needsReview = lead.emailOptOut || lead.deletedAt || ["won", "lost"].includes(lead.phase) ||
      lead.interestedModelText || interestMismatch ||
      latest?.discountStatus === "pending" || latest?.dutyFreeStatus === "pending";
    if (needsReview) {
      reason = "WhatsApp quote request: vehicle specification, permissions or approvals need review.";
    } else if (!(await services.preflight(dealerId)).ok) {
      reason = "WhatsApp quote request: dealership email sending is unavailable.";
    } else {
      const quote = await services.generate(lead, {
        actor: "AURA WhatsApp Concierge", isAgent: true, trigger: "whatsapp_request",
      });
      if (quote && quote.total > 0) {
        const row = await services.enqueue({
          template: "vehicle_quote", to: lead.email, dealerId,
          customerId: lead.customerId, leadId: lead.id,
          notifyUserId: lead.ownerUserId ?? undefined,
          data: { ...(await services.payload(quote, lead)), quoteId: String(quote.id), leadId: String(lead.id) },
          dedupeKey: `lead:${lead.id}:quote:${quote.id}:email:v1`,
        });
        const reply = row?.recipient?.toLowerCase() === lead.email.toLowerCase() && quoteEmailReply(row.status);
        if (reply) return reply;
        reason = "WhatsApp quote request: email was blocked or failed; quote has not been confirmed sent.";
      }
    }
  } catch {
    // Do not leak SMTP/provider errors or customer data.
    logger.warn({ dealerId, leadId }, "WhatsApp quote preparation needs staff follow-up");
  }
  // Durable, visible fallback, serialized across retrying workers.
  const task = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`whatsapp-quote-followup:${dealerId}:${lead.id}`}))`);
    const [existing] = await tx.select().from(tasksTable).where(and(
      eq(tasksTable.dealerId, dealerId), eq(tasksTable.leadId, lead.id),
      eq(tasksTable.title, "WhatsApp quote request — review and send"), eq(tasksTable.status, "open"),
    )).limit(1);
    if (existing) return null;
    const [created] = await tx.insert(tasksTable).values({
      dealerId, leadId: lead.id, title: "WhatsApp quote request — review and send",
      description: reason, assigneeUserId: lead.ownerUserId, priority: "high",
    }).returning();
    await tx.insert(timelineEventsTable).values({
      dealerId, customerId: lead.customerId, domain: "leads", kind: "whatsapp_handoff",
      title: "WhatsApp quote request recorded for sales", detail: reason,
      actor: "AURA WhatsApp Concierge", isAgent: true, refType: "lead", refId: lead.id,
    });
    return created;
  });
  if (task && lead.ownerUserId) {
    try {
      await notifyUser({ dealerId, userId: lead.ownerUserId, type: "system",
        title: "WhatsApp quote request needs review", body: reason, link: `/lead/${lead.id}` });
    } catch {
      logger.warn({ dealerId, leadId }, "Quote follow-up saved; notification unavailable");
    }
  }
  return QUOTE_REPLIES.handoff;
}