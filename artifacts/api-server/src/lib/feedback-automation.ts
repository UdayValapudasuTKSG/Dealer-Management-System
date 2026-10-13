import { and, asc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import {
  db, feedbackAutomationTable as rules, feedbackFormsTable as forms,
  feedbackInvitationsTable as invitations, deliveriesTable, serviceOrdersTable,
  customersTable, dealsTable, leadsTable, dealersTable, vehiclesTable,
} from "@workspace/db";
import { enqueueEmail, enqueueWhatsapp } from "./email";
import { feedbackFormUrl } from "./email-triggers";
import { suppressesCustomerCommunications } from "./delivery-import-provenance";
import { logger } from "./logger";

import { FEEDBACK_DAY_MS, feedbackDueAt } from "./feedback-automation-policy";
type Kind = "sales" | "service";
type Rule = typeof rules.$inferSelect;

async function source(dealerId: number, kind: Kind, id: number) {
  if (kind === "sales") {
    const [row] = await db.select({
      customerId: deliveriesTable.customerId, completedAt: deliveriesTable.deliveredAt,
      status: deliveriesTable.status, importMetadata: deliveriesTable.importMetadata,
      leadId: dealsTable.leadId, vehicle: sql<string>`concat_ws(' ', ${vehiclesTable.year}, ${vehiclesTable.make}, ${vehiclesTable.model})`,
    }).from(deliveriesTable).leftJoin(dealsTable, and(
      eq(dealsTable.id, deliveriesTable.dealId), eq(dealsTable.dealerId, dealerId),
    )).leftJoin(vehiclesTable, and(eq(vehiclesTable.id, deliveriesTable.vehicleId), eq(vehiclesTable.dealerId, dealerId)))
      .where(and(eq(deliveriesTable.id, id), eq(deliveriesTable.dealerId, dealerId)));
    return row?.status === "completed" ? row : null;
  }
  const [row] = await db.select({
    customerId: serviceOrdersTable.customerId, completedAt: serviceOrdersTable.closedAt,
    status: serviceOrdersTable.status, vehicle: serviceOrdersTable.vehicleInfo,
  }).from(serviceOrdersTable).where(and(eq(serviceOrdersTable.id, id), eq(serviceOrdersTable.dealerId, dealerId)));
  return row?.status === "closed" ? { ...row, leadId: null, importMetadata: null } : null;
}

type Senders = {
  email: (options: Parameters<typeof enqueueEmail>[0]) => Promise<{ id: number }>;
  whatsapp: (options: Parameters<typeof enqueueWhatsapp>[0]) => Promise<{ id: number }>;
};
export async function processFeedbackEvent(rule: Rule, id: number, now: Date,
  senders: Senders = { email: enqueueEmail, whatsapp: enqueueWhatsapp }) {
  const key = `survey:${rule.dealerId}:${rule.kind}:${id}`;
  // Serializes replicas and rule edits; the persisted invitation + channel dedupe
  // keys recover safely even when a process stops between channel enqueues.
  await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
    const [current] = await tx.select().from(rules).where(and(
      eq(rules.dealerId, rule.dealerId), eq(rules.kind, rule.kind),
    )).for("share");
    if (!current?.enabled || current.formId == null) return;
    const event = await source(rule.dealerId, rule.kind, id);
    if (!event?.completedAt || event.completedAt < current.startsAt ||
        feedbackDueAt(event.completedAt, current.delayDays) > now) return;
    const [form] = await db.select().from(forms).where(and(
      eq(forms.id, current.formId), eq(forms.dealerId, rule.dealerId), eq(forms.status, "published"),
    ));
    if (!form) return;
    let [inv] = await db.select().from(invitations).where(eq(invitations.automationKey, key));
    if (inv && inv.automationState !== "pending") return;
    if (!inv) {
      [inv] = await db.insert(invitations).values({
        dealerId: rule.dealerId, formId: form.id, customerId: event.customerId,
        // Event-bound so repeat purchases/visits get their own survey.
        leadId: null, serviceOrderId: rule.kind === "service" ? id : null,
        deliveryId: rule.kind === "sales" ? id : null,
        vehicleLabel: event.vehicle, formName: form.name, questionsSnapshot: form.questions,
        expiresAt: new Date(now.getTime() + 30 * FEEDBACK_DAY_MS),
        automationKey: key, automationKind: rule.kind, automationState: "pending",
        channels: current.channels, createdBy: "Automatic post-completion survey",
      }).onConflictDoNothing().returning();
      if (!inv) return;
    }
    const [customer] = event.customerId == null ? [] : await db.select().from(customersTable)
      .where(and(eq(customersTable.id, event.customerId), eq(customersTable.dealerId, rule.dealerId),
        isNull(customersTable.deletedAt), isNull(customersTable.erasedAt)));
    const [lead] = event.leadId == null ? [] : await db.select().from(leadsTable)
      .where(and(eq(leadsTable.id, event.leadId), eq(leadsTable.dealerId, rule.dealerId)));
    if (!customer || suppressesCustomerCommunications(event) ||
        (lead && (lead.deletedAt || suppressesCustomerCommunications(lead)))) {
      await db.update(invitations).set({ automationState: "skipped",
        automationError: "Customer unavailable or customer communications suppressed." }).where(eq(invitations.id, inv.id));
      return;
    }
    const link = inv.token ? feedbackFormUrl(inv.token) : null;
    if (!link) throw new Error("Public feedback URL is not configured");
    const channels = inv.channels as Array<"email" | "whatsapp">;
    const context = rule.kind === "sales" ? "your vehicle delivery" : `your service visit for ${event.vehicle}`;
    try {
      let emailLogId = inv.emailLogId, whatsappLogId = inv.whatsappLogId;
      if (channels.includes("email") && customer.email && !emailLogId) {
        const log = await senders.email({
          dealerId: rule.dealerId, customerId: customer.id, leadId: event.leadId,
          template: "feedback.survey", to: customer.email,
          data: { name: customer.name, context, link }, dedupeKey: `${key}:email`,
        });
        emailLogId = log.id;
        await db.update(invitations).set({ emailLogId }).where(eq(invitations.id, inv.id));
      }
      if (channels.includes("whatsapp") && customer.phone && !whatsappLogId) {
        const log = await senders.whatsapp({
          dealerId: rule.dealerId, customerId: customer.id, leadId: event.leadId,
          kind: "feedback.survey", to: customer.phone,
          body: `Hi ${customer.name} — please share your feedback on ${context}: ${link}`,
          summary: `Feedback form: ${inv.formName}`, dedupeKey: `${key}:whatsapp`,
        });
        whatsappLogId = log.id;
        await db.update(invitations).set({ whatsappLogId }).where(eq(invitations.id, inv.id));
      }
      await db.update(invitations).set({
        automationState: emailLogId || whatsappLogId ? "queued" : "skipped",
        automationError: emailLogId || whatsappLogId ? null : "No contact details for the selected channels.",
      }).where(eq(invitations.id, inv.id));
    } catch (error) {
      await db.update(invitations).set({ automationError: "Queueing failed; automatic retry pending." })
        .where(eq(invitations.id, inv.id));
      throw error;
    }
  });
}

/** No historical backfill: startsAt is set when a rule is first enabled/re-enabled. */
export async function sweepFeedbackAutomation(now = new Date(), onlyDealerId?: number) {
  const configured = await db.select({ rule: rules }).from(rules)
    .innerJoin(dealersTable, and(eq(dealersTable.id, rules.dealerId), eq(dealersTable.status, "active")))
    .where(and(eq(rules.enabled, true), onlyDealerId == null ? undefined : eq(rules.dealerId, onlyDealerId)));
  for (const { rule } of configured) {
    const cutoff = new Date(now.getTime() - rule.delayDays * FEEDBACK_DAY_MS);
    const table = rule.kind === "sales" ? deliveriesTable : serviceOrdersTable;
    const completed = rule.kind === "sales" ? deliveriesTable.deliveredAt : serviceOrdersTable.closedAt;
    const candidates = await db.select({ id: table.id }).from(table)
      .leftJoin(invitations, eq(invitations.automationKey, sql`'survey:' || ${table.dealerId} || ':' || ${rule.kind} || ':' || ${table.id}`))
      .where(and(eq(table.dealerId, rule.dealerId), eq(table.status, rule.kind === "sales" ? "completed" : "closed"),
        gte(completed, rule.startsAt), lte(completed, cutoff), isNull(invitations.id)))
      .orderBy(asc(completed)).limit(100);
    const pending = await db.select().from(invitations).where(and(
      eq(invitations.dealerId, rule.dealerId), eq(invitations.automationKind, rule.kind),
      eq(invitations.automationState, "pending"),
    )).orderBy(asc(invitations.id)).limit(100);
    const ids = new Set([...pending.map(i => Number(i.automationKey?.split(":").at(-1))), ...candidates.map(c => c.id)]);
    for (const id of ids) {
      try { await processFeedbackEvent(rule, id, now); }
      catch (err) { logger.error({ err, dealerId: rule.dealerId, kind: rule.kind, id }, "Automatic feedback queue failed"); }
    }
  }
}
