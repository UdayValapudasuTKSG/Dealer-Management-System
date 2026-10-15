import { Router, type IRouter } from "express";
import { z } from "zod";
import { and, eq, desc, sql, inArray } from "drizzle-orm";
import {
  db, dealersTable, dealsTable, vehiclesTable, invoicesTable, paymentsTable, dealItemsTable, quotesTable,
  erpnextRefsTable, erpnextSyncJobsTable, auditLogsTable, normalizeModelKey,
  salesAccountingSettingsTable as settings, salesAccountingWorkflowsTable as workflows,
  salesAccountingEntriesTable as entries, type SalesAccountingInput,
} from "@workspace/db";
import { activeDealerId } from "../middlewares/rbac";
import { buildSalesPreview, EMPTY_SALES_CONFIG, SALES_STAGES, ACCOUNT_ROLES } from "../lib/sales-accounting-policy";
import { fieldAccessFor } from "../lib/field-permissions";

const router: IRouter = Router();
const accountName = z.string().trim().max(180);
const configSchema = z.object({
  customerCharges: z.array(z.object({
    category: z.enum(["registration", "fuel", "detailing"]), incomeAccount: accountName,
    taxTreatment: z.enum(["pending", "taxable", "exempt", "zero_rated"]),
    vatRate: z.number().finite().min(0).max(100), amountIncludesVat: z.boolean(),
    approved: z.boolean(), approvalReference: z.string().trim().max(500),
  }).strict()).max(3).optional(),
  revision: z.number().int().nonnegative(),
  accounts: z.array(z.object({ key: z.string(), account: accountName })).max(30),
  sources: z.array(z.object({ id: z.string().trim().min(1).max(60), label: z.string().trim().min(1).max(120),
    kind: z.enum(["bank", "cash", "float", "supplier"]), account: accountName })).max(100),
  models: z.array(z.object({ make: z.string().trim().min(1).max(100), model: z.string().trim().min(1).max(100),
    income: accountName, dutyFreeIncome: accountName, inventory: accountName, cogs: accountName, discount: accountName })).max(250),
}).strict();
const money = z.number().finite().min(0).max(1e12).refine(v => Math.abs(v * 100 - Math.round(v * 100)) < 0.001, "Use at most two decimal places");
const inputSchema = z.object({
  billingTreatment: z.enum(["dealer_paid", "customer_billed"]).optional(),
  customerChargeAmount: money.optional(),
  stage: z.enum(["VS-01", "VS-02", "VS-03", "VS-04", "VS-05", "VS-06", "VS-07", "VS-08", "VS-09", "VS-10"]),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v, "Invalid date"),
  amount: money, revision: z.number().int().nonnegative(),
  sourceId: z.string().max(60).optional(), expenseType: z.enum(["registration", "fuel", "detailing"]).optional(),
  payerType: z.enum(["customer", "financier"]).optional(), reference: z.string().trim().max(250).optional(),
  notes: z.string().trim().max(4000).optional(), invoiceId: z.number().int().positive().optional(),
  paymentId: z.number().int().positive().optional(), discount: money.optional(), vat: money.optional(),
  cost: money.optional(), costEvidence: z.string().trim().max(1000).optional(),
}).strict();

function failure(message: string, status = 422): never {
  throw Object.assign(new Error(message), { status });
}
async function eligible(dealerId: number) {
  const [dealer] = await db.select({ name: dealersTable.name }).from(dealersTable).where(eq(dealersTable.id, dealerId));
  // Production scope is the explicitly approved dealer, not any renamed dealer.
  return (process.env.NODE_ENV !== "production" || dealerId === 2) &&
    dealer?.name.trim().toLowerCase() === "cam motors dummy";
}
async function configResponse(dealerId: number) {
  const [row] = await db.select().from(settings).where(eq(settings.dealerId, dealerId));
  return { eligible: await eligible(dealerId), vatPolicy: "pending", revision: row?.revision ?? 0,
    ...(row?.config ?? EMPTY_SALES_CONFIG), accountRoles: ACCOUNT_ROLES,
    validation: row?.validation ?? { state: "unchecked", errors: [] } };
}
const requirements: Record<string, string> = {
  "VS-01": "Link an existing quote. Confirm vehicle specification, price and tax; no accounting entry.",
  "VS-02": "Record the sales-order reference. VIN allocation remains subject to AURA's existing stock/commitment controls; this does not reserve stock.",
  "VS-03": "Receiving source, amount and receipt reference. VAT policy pending: cannot post.",
  "VS-04": "Receipt and bank-statement reference. Matching is not a second receipt or GL entry.",
  "VS-05": "Expense category, funding source/supplier, amount and evidence. Prepare separate categories in the supporting reference; no stock capitalization implied.",
  "VS-06": "Existing final invoice, total including tax, discount and VAT. Requires actual delivery evidence before execution.",
  "VS-07": "Assigned VIN and independently verified cost with stock-valuation evidence. Selling price is not cost.",
  "VS-08": "Existing deposit receipt, target final invoice and amount. Cannot exceed unapplied deposit or invoice balance.",
  "VS-09": "Customer or financier, receiving source, receipt and amount. Financier receivable transfer must be established separately.",
  "VS-10": "Alternative cancellation path: approved refund and unused deposit. Not a normal final stage after delivery.",
};
async function dealRow(dealerId: number, dealId: number) {
  const [row] = await db.select({ deal: dealsTable, vehicle: vehiclesTable, enrolledId: workflows.id })
    .from(dealsTable).leftJoin(vehiclesTable, and(eq(vehiclesTable.id, dealsTable.vehicleId), eq(vehiclesTable.dealerId, dealerId)))
    .leftJoin(workflows, and(eq(workflows.dealId, dealsTable.id), eq(workflows.dealerId, dealerId)))
    .where(and(eq(dealsTable.id, dealId), eq(dealsTable.dealerId, dealerId)));
  if (!row) failure("Deal not found", 404);
  return row;
}
async function workflowResponse(dealerId: number, dealId: number) {
  const { deal, vehicle, enrolledId } = await dealRow(dealerId, dealId);
  const config = await configResponse(dealerId);
  const rows = await db.select().from(entries).where(and(eq(entries.dealerId, dealerId), eq(entries.dealId, dealId))).orderBy(entries.stage);
  return {
    deal: { id: deal.id, customerName: deal.customerName ?? "Customer", stage: deal.stage, amount: deal.otdPrice,
      enrolled: !!enrolledId, vehicle: vehicle ? `${vehicle.make} ${vehicle.model}` : "VIN not assigned", vin: vehicle?.vin ?? "" },
    config, stages: SALES_STAGES.map(s => ({ ...s, requirements: requirements[s.id] })),
    entries: rows.map(r => ({ ...r, input: { ...r.input, revision: r.revision },
      blockers: [...r.blockers, ...(r.configRevision !== config.revision ? ["GL configuration changed: save and review this workpaper again."] : [])],
      updatedAt: r.updatedAt.toISOString(), ...(r.reviewedAt ? { reviewedAt: r.reviewedAt.toISOString() } : { reviewedAt: undefined }) })),
    notice: "CAM Motors Dummy preparation mode. Financial workpapers are not receipts, invoices, VIN reservations or ERPNext postings. Enrolled deals' legacy invoice/payment sync is held pending finance-approved VAT and execution policy.",
  };
}

router.use("/sales-accounting", async (req, res, next) => {
  try {
    const user = res.locals.user;
    // Require view even for mutation permissions; do not rely on admin implying view.
    if (!user?.permissions.some(p => p.module === "finance" && p.category === "view")) {
      res.status(403).json({ error: "Finance view permission required" }); return;
    }
    const access = await fieldAccessFor(user, "deals");
    if (access.some(a => a.access === "hidden" && a.group.fields.some(f => ["vehiclePrice", "otdPrice", "discount"].includes(f)))) {
      res.status(403).json({ error: "Deal pricing access is required for sales accounting" }); return;
    }
    if (req.method !== "GET" && !(await eligible(activeDealerId(res)))) {
      res.status(403).json({ error: "This workflow is enabled only for CAM Motors Dummy" }); return;
    }
    next();
  } catch (err) { next(err); }
});

router.get("/sales-accounting/config", async (_req, res) => { res.json(await configResponse(activeDealerId(res))); });
router.put("/sales-accounting/config", async (req, res) => {
  const parsed = configSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const { revision, ...config } = parsed.data;
  for (const rule of config.customerCharges ?? []) {
    if (rule.approved && (!rule.incomeAccount || !rule.approvalReference || rule.taxTreatment === "pending" ||
      (rule.taxTreatment === "taxable" ? rule.vatRate <= 0 : rule.vatRate !== 0))) {
      failure("Approved customer-charge rules require an income account, approval reference and explicit valid VAT treatment.");
    }
  }
  if (config.accounts.some(a => !ACCOUNT_ROLES.some(r => r.key === a.key))) failure("Unknown account role", 400);
  for (const keys of [(config.customerCharges ?? []).map(r => r.category), config.accounts.map(a => a.key), config.sources.map(s => s.id),
    config.models.map(m => `${normalizeModelKey(m.make)}|${normalizeModelKey(m.model)}`)]) {
    if (keys.length !== new Set(keys).size) failure("Duplicate account role, source ID or vehicle model", 400);
  }
  const dealerId = activeDealerId(res);
  await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(76043, ${dealerId})`);
    const [before] = await tx.select().from(settings).where(eq(settings.dealerId, dealerId));
    if ((before?.revision ?? 0) !== revision) failure("Configuration changed. Reload before saving.", 409);
    if (config.customerCharges === undefined) config.customerCharges = before?.config.customerCharges;
    for (const rule of config.customerCharges ?? []) {
      const previous = before?.config.customerCharges?.find(r => r.category === rule.category);
      if (rule.approved && JSON.stringify(rule) !== JSON.stringify(previous) &&
        !res.locals.user!.permissions.some(p => p.module === "finance" && p.category === "approve")) {
        failure("Finance approve permission is required to approve or change approved customer-charge rules.", 403);
      }
    }
    await tx.insert(settings).values({ dealerId, config, updatedBy: res.locals.user!.id })
      .onConflictDoUpdate({ target: settings.dealerId, set: { config, revision: revision + 1, validation: null, updatedBy: res.locals.user!.id, updatedAt: new Date() } });
    await tx.insert(auditLogsTable).values({ dealerId, actorUserId: res.locals.user!.id, action: "update", module: "finance",
      entityType: "sales_accounting_settings", entityId: String(dealerId), summary: "Updated sales accounting GL workpaper configuration",
      details: { before: before?.config ?? null, after: config, revision: revision + 1 } });
  });
  res.json(await configResponse(dealerId));
});

router.post("/sales-accounting/validate", async (_req, res) => {
  const dealerId = activeDealerId(res);
  await db.transaction(async tx => {
    const [row] = await tx.select().from(settings).where(eq(settings.dealerId, dealerId)).for("update");
    if (!row) failure("Save the configuration first");
    await tx.update(settings).set({ validation: { state: "queued", errors: [] } }).where(eq(settings.dealerId, dealerId));
    await tx.insert(erpnextSyncJobsTable).values({ dealerId, direction: "outbound", doctype: "AURA Sales GL Validation",
      operation: "insert", entityType: "sales_gl_config", entityId: dealerId, payload: { revision: row.revision }, status: "queued" });
  });
  res.json(await configResponse(dealerId));
});
router.get("/sales-accounting/deals", async (_req, res) => {
  const dealerId = activeDealerId(res);
  if (!(await eligible(dealerId))) { res.json([]); return; }
  const rows = await db.select({ deal: dealsTable, enrolledId: workflows.id, vehicle: vehiclesTable }).from(dealsTable)
    .leftJoin(workflows, and(eq(workflows.dealId, dealsTable.id), eq(workflows.dealerId, dealerId)))
    .leftJoin(vehiclesTable, and(eq(vehiclesTable.id, dealsTable.vehicleId), eq(vehiclesTable.dealerId, dealerId)))
    .where(eq(dealsTable.dealerId, dealerId)).orderBy(desc(dealsTable.id)).limit(500);
  res.json(rows.map(({ deal, enrolledId, vehicle }) => ({ id: deal.id, customerName: deal.customerName ?? "Customer",
    stage: deal.stage, amount: deal.otdPrice, enrolled: !!enrolledId, vehicle: vehicle ? `${vehicle.make} ${vehicle.model}` : "VIN not assigned", vin: vehicle?.vin ?? "" })));
});
router.get("/sales-accounting/deals/:dealId", async (req, res) => {
  const dealId = z.coerce.number().int().positive().parse(req.params.dealId);
  if (!(await eligible(activeDealerId(res)))) failure("Workflow unavailable for this dealership", 404);
  res.json(await workflowResponse(activeDealerId(res), dealId));
});
router.post("/sales-accounting/deals/:dealId", async (req, res) => {
  const dealerId = activeDealerId(res), dealId = z.coerce.number().int().positive().parse(req.params.dealId);
  await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(76042, ${dealerId})`);
    const { deal, enrolledId } = await dealRow(dealerId, dealId);
    if (enrolledId) return;
    if (["delivered", "cancelled"].includes(deal.stage)) failure("Historical/terminal deals cannot be enrolled");
    const items = await tx.select().from(dealItemsTable).where(and(eq(dealItemsTable.dealId, dealId), eq(dealItemsTable.dealerId, dealerId)));
    if (items.reduce((n, i) => n + i.quantity, 0) > 1) failure("This one-vehicle workflow does not support multi-vehicle deals. Keep this deal in the existing flow.");
    const inv = await tx.select().from(invoicesTable).where(and(eq(invoicesTable.dealId, dealId), eq(invoicesTable.dealerId, dealerId)));
    if (inv.length) {
      const ids = inv.map(i => i.id);
      const [paid] = await tx.select().from(paymentsTable).where(and(eq(paymentsTable.dealerId, dealerId), inArray(paymentsTable.invoiceId, ids))).limit(1);
      const [ref] = await tx.select().from(erpnextRefsTable).where(and(eq(erpnextRefsTable.dealerId, dealerId), eq(erpnextRefsTable.entityType, "invoice"), inArray(erpnextRefsTable.entityId, ids))).limit(1);
      // A succeeded or attempted job without a ref can represent a remote-create crash.
      // Never enrol it based solely on missing local refs.
      const attempted = await tx.select().from(erpnextSyncJobsTable).where(and(eq(erpnextSyncJobsTable.dealerId, dealerId), eq(erpnextSyncJobsTable.entityType, "invoice"), inArray(erpnextSyncJobsTable.entityId, ids)));
      if (paid || ref || attempted.some(j => j.attempts > 0 || j.status !== "queued")) failure("Deal already has receipts or attempted ERPNext postings. Historical transactions cannot be moved into preparation mode.");
    }
    await tx.insert(workflows).values({ dealerId, dealId, startedBy: res.locals.user!.id });
    await tx.insert(auditLogsTable).values({ dealerId, actorUserId: res.locals.user!.id, action: "create", module: "finance",
      entityType: "sales_accounting_workflow", entityId: String(dealId), summary: "Enrolled dummy deal in accounting preparation; ERP financial sync held" });
  });
  res.json(await workflowResponse(dealerId, dealId));
});

router.put("/sales-accounting/deals/:dealId/entries", async (req, res) => {
  const parsed = inputSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const dealerId = activeDealerId(res), dealId = z.coerce.number().int().positive().parse(req.params.dealId);
  const { revision, ...input } = parsed.data;
  await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(76043, ${dealerId})`);
    const { deal, vehicle, enrolledId } = await dealRow(dealerId, dealId);
    if (!enrolledId) failure("Enroll this deal before saving workpapers");
    const [config] = await tx.select().from(settings).where(eq(settings.dealerId, dealerId));
    const [before] = await tx.select().from(entries).where(and(eq(entries.dealerId, dealerId), eq(entries.dealId, dealId), eq(entries.stage, input.stage)));
    if ((before?.revision ?? 0) !== revision) failure("Workpaper changed. Reload before saving.", 409);
    if (input.invoiceId) {
      const [invoice] = await tx.select().from(invoicesTable).where(and(eq(invoicesTable.id, input.invoiceId), eq(invoicesTable.dealerId, dealerId), eq(invoicesTable.dealId, dealId)));
      if (!invoice) failure("Invoice not found for this deal", 404);
    }
    if (input.paymentId) {
      const [payment] = await tx.select().from(paymentsTable).innerJoin(invoicesTable, eq(paymentsTable.invoiceId, invoicesTable.id))
        .where(and(eq(paymentsTable.id, input.paymentId), eq(paymentsTable.dealerId, dealerId), eq(invoicesTable.dealerId, dealerId), eq(invoicesTable.dealId, dealId)));
      if (!payment) failure("Receipt not found for this deal", 404);
      if (input.invoiceId && payment.payments.invoiceId !== input.invoiceId && input.stage !== "VS-08") failure("Receipt belongs to a different invoice");
    }
    const preview = buildSalesPreview(config?.config ?? EMPTY_SALES_CONFIG, input,
      vehicle ? { make: vehicle.make, model: vehicle.model, dutyFree: deal.dutyFreeApproved } : null);
    if (SALES_STAGES.find(s => s.id === input.stage)?.posts && config?.validation?.state !== "valid") {
      preview.blockers.push("Validate this GL configuration against ERPNext before finance review.");
    }
    const values = { input: input as SalesAccountingInput, lines: preview.lines, blockers: preview.blockers,
      state: "draft", revision: revision + 1, configRevision: config?.revision ?? 0, reviewedBy: null, reviewedAt: null,
      updatedBy: res.locals.user!.id, updatedAt: new Date() };
    await tx.insert(entries).values({ dealerId, dealId, stage: input.stage, ...values }).onConflictDoUpdate({
      target: [entries.dealerId, entries.dealId, entries.stage], set: values });
    await tx.insert(auditLogsTable).values({ dealerId, actorUserId: res.locals.user!.id, action: "update", module: "finance",
      entityType: "sales_accounting_entry", entityId: `${dealId}:${input.stage}`, summary: "Saved unposted finance workpaper",
      details: { before: before?.input ?? null, after: input, revision: revision + 1 } });
  });
  res.json(await workflowResponse(dealerId, dealId));
});
router.post("/sales-accounting/deals/:dealId/review", async (req, res) => {
  const input = z.object({ stage: z.string(), revision: z.number().int().positive() }).strict().parse(req.body);
  const dealerId = activeDealerId(res), dealId = z.coerce.number().int().positive().parse(req.params.dealId);
  await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(76043, ${dealerId})`);
    const [entry] = await tx.select().from(entries).where(and(eq(entries.dealerId, dealerId), eq(entries.dealId, dealId), eq(entries.stage, input.stage)));
    if (!entry) failure("Workpaper not found", 404);
    if (entry.updatedBy === res.locals.user!.id) failure("A different Finance approver must review this workpaper.", 403);
    if (entry.revision !== input.revision) failure("Workpaper changed. Reload before reviewing.", 409);
    const [config] = await tx.select().from(settings).where(eq(settings.dealerId, dealerId));
    if (entry.configRevision !== (config?.revision ?? 0)) failure("GL configuration changed. Save the workpaper again.");
    if (SALES_STAGES.find(s => s.id === entry.stage)?.posts && config?.validation?.state !== "valid") {
      failure("ERPNext account validation must be valid before Finance reviews this workpaper.");
    }
    if (!entry.input.reference?.trim()) failure("Supporting reference is required before review");
    const reviewBlockers = entry.blockers.filter(b => !b.startsWith("ERPNext posting is held:"));
    if (reviewBlockers.length) failure(reviewBlockers.join(" "));
    const { deal, vehicle } = await dealRow(dealerId, dealId);
    let state = "reviewed";
    if (entry.stage === "VS-01") {
      if (!deal.quoteId) failure("Link an existing quotation to the deal first");
      const [quote] = await tx.select({ id: quotesTable.id }).from(quotesTable)
        .where(and(eq(quotesTable.id, deal.quoteId), eq(quotesTable.dealerId, dealerId)));
      if (!quote) failure("Linked quotation not found for this dealership");
      state = "complete";
    }
    if (entry.stage === "VS-02") {
      // Do not claim a VIN is reserved based only on a typed reference.
      if (!vehicle?.vin || !["committed", "delivered"].includes(deal.stage)) failure("Complete the existing VIN allocation/commitment controls first. A workpaper cannot reserve stock.");
      state = "complete";
    }
    if (entry.stage === "VS-04") {
      if (!entry.input.paymentId) failure("Select an actual AURA receipt before confirming bank matching");
      state = "complete";
    }
    await tx.update(entries).set({ state, reviewedBy: res.locals.user!.id, reviewedAt: new Date(),
      revision: entry.revision + 1, updatedAt: new Date() }).where(eq(entries.id, entry.id));
    await tx.insert(auditLogsTable).values({ dealerId, actorUserId: res.locals.user!.id, action: "approve", module: "finance",
      entityType: "sales_accounting_entry", entityId: String(entry.id), summary: `Reviewed ${entry.stage} workpaper; no GL posting`,
      details: { revision: entry.revision, configRevision: entry.configRevision, input: entry.input, lines: entry.lines, blockers: entry.blockers } });
  });
  res.json(await workflowResponse(dealerId, dealId));
});
router.use("/sales-accounting", (err: unknown, _req: unknown, res: import("express").Response, next: import("express").NextFunction) => {
  if (err instanceof z.ZodError) { res.status(400).json({ error: err.message }); return; }
  if (err instanceof Error && "status" in err && typeof err.status === "number") { res.status(err.status).json({ error: err.message }); return; }
  next(err);
});
export default router;
