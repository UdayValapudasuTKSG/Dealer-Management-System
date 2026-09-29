import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  db, customersTable, customerComplaintsTable, leadsTable,
  smtpConnectionsTable,
} from "@workspace/db";
import { activeDealerId, hasPermission } from "../middlewares/rbac";
import { eligibleInternalRecipients, internalRecipientPolicy } from "../lib/internal-email-recipients";
import { generalManagers } from "../lib/notify-matrix";
import { enqueueEmail } from "../lib/email";
import { isCallCentreRole, isActiveCallCentreLead } from "../lib/call-centre-policy";
import { isOwnRestrictedRole, ownsLead, LEAD_NOT_OWNED } from "../lib/lead-ownership";

const router: IRouter = Router();
const paramsSchema = z.object({ id: z.coerce.number().int().positive() });
const complaintParams = paramsSchema.extend({ complaintId: z.coerce.number().int().positive() });
const createSchema = z.object({
  title: z.string().trim().min(1).max(200),
  details: z.string().trim().min(1).max(10000),
  severity: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  escalated: z.boolean().default(false),
  leadId: z.number().int().positive().optional(),
});
const updateSchema = z.object({
  status: z.enum(["open", "in_progress", "resolved", "closed"]).optional(),
  severity: z.enum(["low", "medium", "high", "critical"]).optional(),
  escalated: z.boolean().optional(),
}).refine(x => Object.keys(x).length > 0, "Provide a change");

async function customerExists(dealerId: number, customerId: number) {
  const [customer] = await db.select({ id: customersTable.id, name: customersTable.name })
    .from(customersTable).where(and(eq(customersTable.id, customerId), eq(customersTable.dealerId, dealerId)));
  return customer;
}

async function leadForComplaint(dealerId: number, leadId: number) {
  const [lead] = await db.select({
    id: leadsTable.id, name: leadsTable.name, customerId: leadsTable.customerId,
    ownerUserId: leadsTable.ownerUserId, assignedTo: leadsTable.assignedTo,
    callCentreRepId: leadsTable.callCentreRepId, callCentreStatus: leadsTable.callCentreStatus,
    callCentreTransferredAt: leadsTable.callCentreTransferredAt, deletedAt: leadsTable.deletedAt,
  }).from(leadsTable).where(and(eq(leadsTable.id, leadId), eq(leadsTable.dealerId, dealerId)));
  return lead?.deletedAt ? undefined : lead;
}

function canAccessLeadComplaint(user: NonNullable<Express.Locals["user"]>, lead: NonNullable<Awaited<ReturnType<typeof leadForComplaint>>>, write = false) {
  if (isCallCentreRole(user.roleName)) {
    return lead.callCentreRepId === user.id && (!write || (!lead.callCentreTransferredAt && isActiveCallCentreLead(lead)));
  }
  return !write || !isOwnRestrictedRole(user) || ownsLead(user, lead);
}

// Manager recipient selection is resolved BEFORE the transaction so the outbox
// insert and complaint update always commit together.
async function escalationRecipients(dealerId: number) {
  const template = "customer.complaint.escalated" as const;
  const [managerIds, eligible, policy, smtp] = await Promise.all([
    generalManagers(dealerId),
    eligibleInternalRecipients(dealerId, template),
    internalRecipientPolicy(dealerId, template),
    db.select({ enabled: smtpConnectionsTable.enabled, passwordCiphertext: smtpConnectionsTable.passwordCiphertext })
      .from(smtpConnectionsTable).where(eq(smtpConnectionsTable.dealerId, dealerId)),
  ]);
  if (!smtp[0]?.enabled || !smtp[0]?.passwordCiphertext) return { recipients: [], reason: "SMTP is not configured or enabled" };
  const recipients = eligible.filter(u => managerIds.includes(u.id) && (policy === null || policy.userIds.includes(u.id)));
  return { recipients, reason: policy && !recipients.length ? "Manager notification is off in internal recipient settings" : "No eligible manager recipient" };
}

async function queueEscalation(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  complaint: typeof customerComplaintsTable.$inferSelect,
  customerName: string,
  recipients: Awaited<ReturnType<typeof escalationRecipients>>["recipients"],
) {
  const host = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim() || process.env.REPLIT_DEV_DOMAIN?.trim();
  const link = host ? complaint.customerId
    ? `https://${host}/customers/${complaint.customerId}?tab=complaints`
    : `https://${host}/lead/${complaint.leadId}?tab=complaints` : "";
  for (const manager of recipients) {
    await enqueueEmail({
      tx, deferProcessing: true, template: "customer.complaint.escalated",
      dealerId: complaint.dealerId, customerId: complaint.customerId,
      leadId: complaint.leadId, to: manager.email,
      internalRouted: true, internalRequiredModule: complaint.customerId ? "customers" : undefined,
      dedupeKey: `customer:complaint:${complaint.id}:escalation:u${manager.id}`,
      data: {
        title: complaint.title, details: complaint.details,
        severity: complaint.severity, name: customerName, link,
      },
    });
  }
}

router.get("/customers/:id/complaints", async (req, res): Promise<void> => {
  if (!res.locals.user || !hasPermission(res.locals.user, "customers", "view")) {
    res.status(403).json({ error: "Customer view permission required" }); return;
  }
  const parsed = paramsSchema.safeParse(req.params);
  if (!parsed.success) { res.status(400).json({ error: "Invalid customer ID" }); return; }
  const dealerId = activeDealerId(res);
  if (!await customerExists(dealerId, parsed.data.id)) { res.status(404).json({ error: "Customer not found" }); return; }
  const rows = await db.select().from(customerComplaintsTable).where(and(
    eq(customerComplaintsTable.dealerId, dealerId), eq(customerComplaintsTable.customerId, parsed.data.id),
  )).orderBy(desc(customerComplaintsTable.createdAt));
  res.json(rows);
});

router.post("/customers/:id/complaints", async (req, res): Promise<void> => {
  if (!res.locals.user || !hasPermission(res.locals.user, "customers", "edit") || !hasPermission(res.locals.user, "customers", "view")) {
    res.status(403).json({ error: "Customer edit and view permissions required" }); return;
  }
  const params = paramsSchema.safeParse(req.params);
  const body = createSchema.safeParse(req.body);
  if (!params.success || !body.success) { res.status(400).json({ error: "Invalid complaint details" }); return; }
  const dealerId = activeDealerId(res);
  const customer = await customerExists(dealerId, params.data.id);
  if (!customer) { res.status(404).json({ error: "Customer not found" }); return; }
  if (body.data.leadId) {
    const [lead] = await db.select({ id: leadsTable.id }).from(leadsTable).where(and(
      eq(leadsTable.id, body.data.leadId), eq(leadsTable.dealerId, dealerId), eq(leadsTable.customerId, customer.id),
    ));
    if (!lead) { res.status(400).json({ error: "Lead must belong to this customer and dealership" }); return; }
  }
  const delivery = body.data.escalated ? await escalationRecipients(dealerId) : null;
  const row = await db.transaction(async tx => {
    const [complaint] = await tx.insert(customerComplaintsTable).values({
      ...body.data, dealerId, customerId: customer.id, createdBy: res.locals.user!.id,
    }).returning();
    if (delivery?.recipients.length) await queueEscalation(tx, complaint, customer.name, delivery.recipients);
    return complaint;
  });
  res.status(201).json({ ...row, notification: !delivery ? "not_requested" : delivery.recipients.length ? "queued" : "skipped", notificationReason: delivery && !delivery.recipients.length ? delivery.reason : null });
});

router.patch("/customers/:id/complaints/:complaintId", async (req, res): Promise<void> => {
  if (!res.locals.user || !hasPermission(res.locals.user, "customers", "edit") || !hasPermission(res.locals.user, "customers", "view")) {
    res.status(403).json({ error: "Customer edit and view permissions required" }); return;
  }
  const params = complaintParams.safeParse(req.params);
  const body = updateSchema.safeParse(req.body);
  if (!params.success || !body.success) { res.status(400).json({ error: "Invalid complaint update" }); return; }
  const dealerId = activeDealerId(res);
  const customer = await customerExists(dealerId, params.data.id);
  if (!customer) { res.status(404).json({ error: "Customer not found" }); return; }
  const [existing] = await db.select().from(customerComplaintsTable).where(and(
    eq(customerComplaintsTable.dealerId, dealerId), eq(customerComplaintsTable.customerId, customer.id),
    eq(customerComplaintsTable.id, params.data.complaintId),
  ));
  if (!existing) { res.status(404).json({ error: "Complaint not found" }); return; }
  const delivery = body.data.escalated === true && !existing.escalated ? await escalationRecipients(dealerId) : null;
  const row = await db.transaction(async tx => {
    const [updated] = await tx.update(customerComplaintsTable).set({ ...body.data, updatedAt: new Date() }).where(and(
      eq(customerComplaintsTable.id, existing.id), eq(customerComplaintsTable.dealerId, dealerId),
      eq(customerComplaintsTable.customerId, customer.id),
    )).returning();
    if (delivery?.recipients.length) await queueEscalation(tx, updated, customer.name, delivery.recipients);
    return updated;
  });
  res.json({ ...row, notification: !delivery ? "not_requested" : delivery.recipients.length ? "queued" : "skipped", notificationReason: delivery && !delivery.recipients.length ? delivery.reason : null });
});

router.get("/leads/:id/complaints", async (req, res): Promise<void> => {
  const user = res.locals.user;
  if (!user || !hasPermission(user, "leads", "view")) {
    res.status(403).json({ error: "Lead view permission required" }); return;
  }
  const params = paramsSchema.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid lead ID" }); return; }
  const dealerId = activeDealerId(res);
  const lead = await leadForComplaint(dealerId, params.data.id);
  if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }
  if (!canAccessLeadComplaint(user, lead)) { res.status(403).json(LEAD_NOT_OWNED); return; }
  const rows = await db.select().from(customerComplaintsTable).where(and(
    eq(customerComplaintsTable.dealerId, dealerId), eq(customerComplaintsTable.leadId, lead.id),
  )).orderBy(desc(customerComplaintsTable.createdAt));
  res.json(rows);
});

router.post("/leads/:id/complaints", async (req, res): Promise<void> => {
  const user = res.locals.user;
  if (!user || !hasPermission(user, "leads", "view") || !hasPermission(user, "leads", "edit")) {
    res.status(403).json({ error: "Lead edit and view permissions required" }); return;
  }
  const params = paramsSchema.safeParse(req.params);
  const body = createSchema.omit({ leadId: true }).safeParse(req.body);
  if (!params.success || !body.success) { res.status(400).json({ error: "Invalid complaint details" }); return; }
  const dealerId = activeDealerId(res);
  const lead = await leadForComplaint(dealerId, params.data.id);
  if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }
  if (!canAccessLeadComplaint(user, lead, true)) { res.status(403).json(LEAD_NOT_OWNED); return; }
  // An untrusted/stale customer pointer must never create a cross-dealer link.
  const customer = lead.customerId ? await customerExists(dealerId, lead.customerId) : undefined;
  if (lead.customerId && !customer) { res.status(409).json({ error: "Lead customer link is not valid for this dealership" }); return; }
  const delivery = body.data.escalated ? await escalationRecipients(dealerId) : null;
  const row = await db.transaction(async tx => {
    const [complaint] = await tx.insert(customerComplaintsTable).values({
      ...body.data, dealerId, customerId: customer?.id ?? null, leadId: lead.id, createdBy: user.id,
    }).returning();
    if (delivery?.recipients.length) await queueEscalation(tx, complaint, customer?.name ?? lead.name, delivery.recipients);
    return complaint;
  });
  res.status(201).json({ ...row, notification: !delivery ? "not_requested" : delivery.recipients.length ? "queued" : "skipped", notificationReason: delivery && !delivery.recipients.length ? delivery.reason : null });
});

router.patch("/leads/:id/complaints/:complaintId", async (req, res): Promise<void> => {
  const user = res.locals.user;
  if (!user || !hasPermission(user, "leads", "view") || !hasPermission(user, "leads", "edit")) {
    res.status(403).json({ error: "Lead edit and view permissions required" }); return;
  }
  const params = complaintParams.safeParse(req.params);
  const body = updateSchema.safeParse(req.body);
  if (!params.success || !body.success) { res.status(400).json({ error: "Invalid complaint update" }); return; }
  const dealerId = activeDealerId(res);
  const lead = await leadForComplaint(dealerId, params.data.id);
  if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }
  if (!canAccessLeadComplaint(user, lead, true)) { res.status(403).json(LEAD_NOT_OWNED); return; }
  const [existing] = await db.select().from(customerComplaintsTable).where(and(
    eq(customerComplaintsTable.dealerId, dealerId), eq(customerComplaintsTable.leadId, lead.id),
    eq(customerComplaintsTable.id, params.data.complaintId),
  ));
  if (!existing) { res.status(404).json({ error: "Complaint not found" }); return; }
  const customer = existing.customerId ? await customerExists(dealerId, existing.customerId) : undefined;
  if (existing.customerId && !customer) { res.status(409).json({ error: "Complaint customer link is not valid for this dealership" }); return; }
  const delivery = body.data.escalated === true && !existing.escalated ? await escalationRecipients(dealerId) : null;
  const row = await db.transaction(async tx => {
    const [updated] = await tx.update(customerComplaintsTable).set({ ...body.data, updatedAt: new Date() }).where(and(
      eq(customerComplaintsTable.id, existing.id), eq(customerComplaintsTable.dealerId, dealerId),
      eq(customerComplaintsTable.leadId, lead.id),
    )).returning();
    if (delivery?.recipients.length) await queueEscalation(tx, updated, customer?.name ?? lead.name, delivery.recipients);
    return updated;
  });
  res.json({ ...row, notification: !delivery ? "not_requested" : delivery.recipients.length ? "queued" : "skipped", notificationReason: delivery && !delivery.recipients.length ? delivery.reason : null });
});

export default router;