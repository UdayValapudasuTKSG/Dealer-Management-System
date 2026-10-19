import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db, dealersTable, dealsTable, vehiclesTable, invoicesTable, paymentsTable, erpnextRefsTable, erpnextSyncJobsTable,
  auditLogsTable, usersTable, bookingsTable, salesAccountingSettingsTable as settings, salesAccountingWorkflowsTable as workflows,
  salesFinanceRequestsTable as requests, type SalesFinanceRequest, type SalesFinanceRequestSnapshot,
  type ErpnextSyncJob, type SalesAccountingConfigData,
} from "@workspace/db";
import { evaluateFinanceRequest, type FinancePolicyInput, type FinancePolicyContext } from "./sales-finance-policy";
import { EMPTY_SALES_CONFIG } from "./sales-accounting-policy";
import { applyPayment, PaymentGuardError } from "./invoicing";
import { ErpnextError } from "./erpnext/client";
import type { AuthorizedPosting } from "./erpnext/authorized-payload";
import { isPilotDealerExec, isPilotSalesInvoice } from "./sales-finance-boundary";
import { allocateAdvances, hasApprovedAdvancePolicy, FINAL_INVOICE_VAT_POLICY } from "./sales-advance-policy";

export const SALES_FINANCE_DOCTYPE = "AURA Sales Finance Posting";
const ACTIVE = ["pending", "approved", "posting", "posted", "failed"];
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Exec = typeof db | Tx;

export type Actor = { id: number; name: string; canEdit: boolean; canApprove: boolean };
export type CreateRequestBody = {
  kind: "invoice" | "payment" | "expense";
  date: string;
  amount: string;
  invoiceId?: number;
  legacyPaymentId?: number;
  category?: "registration" | "fuel" | "detailing";
  paymentMethod?: string;
  sourceId?: string;
  payerType?: "customer" | "financier";
  reference: string;
  evidence?: string;
  billingTreatment?: "dealer_paid" | "customer_billed";
  customerCharge?: string;
};

export function fail(message: string, status = 422): never {
  throw Object.assign(new Error(message), { status });
}
/** Exact decimal string -> integer cents (no float drift). */
export function parseCents(value: string | undefined | null): number | null {
  if (value == null || value === "") return null;
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!m) fail("Amounts must be positive decimals with at most two places", 400);
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || 0);
}
function invoiceBasis(i: typeof invoicesTable.$inferSelect) {
  return { id: i.id, invoiceNumber: i.invoiceNumber, kind: i.kind, amountCents: Math.round(i.amount * 100),
    taxCents: Math.round((i.taxLines ?? []).reduce((s, l) => s + l.amount, 0) * 100), customerId: i.customerId ?? null,
    customerName: i.customerName, currency: i.currency ?? "GYD" };
}
/** Differences between the approved invoice basis and the live row. */
export function invoiceDrift(approved: NonNullable<SalesFinanceRequestSnapshot["invoice"]>, live: typeof invoicesTable.$inferSelect | undefined): string[] {
  if (!live) return ["invoice no longer exists"];
  if (live.status === "void") return ["invoice was voided"];
  const now = invoiceBasis(live), out: string[] = [];
  for (const k of ["amountCents", "taxCents", "customerId", "customerName", "currency", "kind"] as const) {
    if (approved[k] === undefined) { out.push(`approval basis is missing ${k}`); continue; }
    if (approved[k] !== now[k]) out.push(`${k} changed`);
  }
  return out;
}
/** Active request id that freezes an invoice against edits, or null. */
export async function salesFinanceInvoiceFreeze(dealerId: number, invoiceId: number): Promise<number | null> {
  const [r] = await db.select({ id: requests.id }).from(requests).where(and(eq(requests.dealerId, dealerId),
    eq(requests.invoiceId, invoiceId), inArray(requests.status, ["pending", "approved", "posting", "posted", "failed"]))).limit(1);
  const [c] = r ? [] : await db.select({ id: requests.id }).from(requests).where(and(eq(requests.dealerId, dealerId), eq(requests.chargeInvoiceId, invoiceId))).limit(1);
  return r?.id ?? c?.id ?? null;
}
/** Dealer availability. Sale-origin enforcement is a separate boundary. */
export async function isPilotDealer(dealerId: number): Promise<boolean> {
  return isPilotDealerExec(db, dealerId);
}
export const paymentReference = (r: Pick<SalesFinanceRequest, "dealerId" | "id" | "reference">) => `${remoteKey(r)} | ${r.reference}`.slice(0, 250);
export const remoteKey = (r: Pick<SalesFinanceRequest, "dealerId" | "id">) => `AURA SFR-${r.dealerId}-${r.id}`;

async function audit(tx: Exec, dealerId: number, actor: { id: number; name?: string } | null, action: string, requestId: number, summary: string, details: Record<string, unknown> = {}) {
  await tx.insert(auditLogsTable).values({ dealerId, actorUserId: actor?.id ?? null, actorName: actor?.name ?? (actor ? null : "ERPNext worker"),
    action, module: "finance", entityType: "sales_finance_request", entityId: String(requestId), summary, details });
}

async function loadConfig(tx: Exec, dealerId: number) {
  const [row] = await tx.select().from(settings).where(eq(settings.dealerId, dealerId));
  return { config: (row?.config ?? EMPTY_SALES_CONFIG) as SalesAccountingConfigData, revision: row?.revision ?? 0, valid: row?.validation?.state === "valid" };
}

async function loadContext(tx: Exec, dealerId: number, dealId: number, invoiceId: number | null | undefined, legacyPaymentId: number | null | undefined, excludeRequestId?: number) {
  const [row] = await tx.select({ deal: dealsTable, vehicle: vehiclesTable, enrolledId: workflows.id }).from(dealsTable)
    .leftJoin(vehiclesTable, and(eq(vehiclesTable.id, dealsTable.vehicleId), eq(vehiclesTable.dealerId, dealerId)))
    .leftJoin(workflows, and(eq(workflows.dealId, dealsTable.id), eq(workflows.dealerId, dealerId)))
    .where(and(eq(dealsTable.id, dealId), eq(dealsTable.dealerId, dealerId)));
  if (!row) fail("Deal not found", 404);
  const ctx: FinancePolicyContext = {
    advancePolicy: await hasApprovedAdvancePolicy(dealerId) ? FINAL_INVOICE_VAT_POLICY : undefined,
    configValid: false, dealStage: row.deal.stage,
    vehicle: row.vehicle ? { make: row.vehicle.make, model: row.vehicle.model, dutyFree: row.deal.dutyFreeApproved, vin: row.vehicle.vin ?? null } : null,
  };
  const saleBaseCents = Math.round(Math.max(row.deal.vehiclePrice - row.deal.discount + row.deal.accessories, 0) * 100);
  ctx.fullSaleAmountCents = saleBaseCents + Math.round(saleBaseCents * 0.14);
  if (row.deal.stage === "desking" && row.vehicle?.vin && row.vehicle.status === "reserved") {
    const [reservation] = await tx.select({ id: bookingsTable.id }).from(bookingsTable).where(and(
      eq(bookingsTable.dealerId, dealerId), eq(bookingsTable.dealId, dealId),
      eq(bookingsTable.vehicleId, row.vehicle.id), eq(bookingsTable.status, "active"),
      sql`(${bookingsTable.expiresAt} IS NULL OR ${bookingsTable.expiresAt} > now())`,
    )).limit(1);
    ctx.hasInvoiceReservation = !!reservation;
  }
  let invoice: typeof invoicesTable.$inferSelect | undefined;
  if (invoiceId) {
    [invoice] = await tx.select().from(invoicesTable).where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.dealerId, dealerId), eq(invoicesTable.dealId, dealId)));
    if (!invoice) fail("Invoice not found for this deal", 404);
    const amountCents = Math.round(invoice.amount * 100);
    const taxCents = Math.round((invoice.taxLines ?? []).reduce((s, l) => s + l.amount, 0) * 100);
    ctx.invoice = { kind: invoice.kind, status: invoice.status, amountCents, taxCents };
    const [{ paid }] = await tx.select({ paid: sql<number>`coalesce(sum(${paymentsTable.amount}),0)::float` }).from(paymentsTable)
      .where(and(eq(paymentsTable.dealerId, dealerId), eq(paymentsTable.invoiceId, invoice.id)));
    const pending = await tx.select({ c: sql<number>`coalesce(sum(${requests.amountCents}),0)::bigint` }).from(requests).where(and(
      eq(requests.dealerId, dealerId), eq(requests.invoiceId, invoice.id), eq(requests.kind, "payment"),
      inArray(requests.status, ["pending", "approved", "posting"]), sql`${requests.paymentId} is null`, sql`${requests.legacyPaymentId} is null`,
      ...(excludeRequestId ? [sql`${requests.id} <> ${excludeRequestId}`] : [])));
    ctx.invoiceOutstandingCents = amountCents - Math.round(paid * 100) - Number(pending[0]?.c ?? 0);
    const [ref] = await tx.select({ id: erpnextRefsTable.id }).from(erpnextRefsTable).where(and(eq(erpnextRefsTable.dealerId, dealerId),
      eq(erpnextRefsTable.entityType, "invoice"), eq(erpnextRefsTable.entityId, invoice.id), eq(erpnextRefsTable.doctype, "Sales Invoice")));
    ctx.invoicePosted = !!ref;
    if (ctx.advancePolicy && invoice.kind === "reservation") {
      const [finalSale] = await tx.select({ id: requests.id }).from(requests).where(and(
        eq(requests.dealerId, dealerId), eq(requests.dealId, dealId), eq(requests.kind, "invoice"),
        inArray(requests.status, ["approved", "posting", "posted", "failed"]),
        sql`${requests.snapshot}->'invoice'->>'kind' = 'final'`)).limit(1);
      ctx.finalSaleStarted = !!finalSale;
    }
    if (ctx.advancePolicy && invoice.kind === "final") {
      const related = await tx.select().from(requests).where(and(eq(requests.dealerId, dealerId), eq(requests.dealId, dealId)));
      ctx.unresolvedAdvance = related.some(r => r.kind === "payment" &&
        r.snapshot.invoice?.kind === "reservation" && ["approved", "posting", "failed"].includes(r.status));
      ctx.invoicePosted = related.some(r => r.kind === "invoice" && r.invoiceId === invoice!.id && r.status === "posted");
      const receipts = related.filter(r => r.kind === "payment" && r.status === "posted" &&
        r.snapshot.advancePolicy === FINAL_INVOICE_VAT_POLICY && r.snapshot.invoice?.kind === "reservation");
      const used = related.filter(r => r.id !== excludeRequestId && ACTIVE.includes(r.status))
        .flatMap(r => r.snapshot.advanceApplications ?? []);
      // A retry may already have its own non-cash credit locally. Add only
      // that exact credit back to the cap so reconciliation is repeatable.
      const [ownCredit] = excludeRequestId ? await tx.select().from(paymentsTable).where(and(
        eq(paymentsTable.dealerId, dealerId), eq(paymentsTable.invoiceId, invoice.id),
        eq(paymentsTable.method, "account_credit"),
        eq(paymentsTable.reference, `AURA SFR-${dealerId}-${excludeRequestId} | NON-CASH DEPOSIT APPLICATION`))) : [];
      const cap = Math.max(0, ctx.invoiceOutstandingCents! + Math.round((ownCredit?.amount ?? 0) * 100));
      ctx.advanceApplications = allocateAdvances(receipts, used, cap);
    }
  }
  const heldIds: { type: string; id: number }[] = [];
  if (invoice) heldIds.push({ type: "invoice", id: invoice.id });
  if (legacyPaymentId) heldIds.push({ type: "payment", id: legacyPaymentId });
  for (const h of heldIds) {
    const [held] = await tx.select({ id: erpnextSyncJobsTable.id }).from(erpnextSyncJobsTable).where(and(
      eq(erpnextSyncJobsTable.dealerId, dealerId), eq(erpnextSyncJobsTable.entityType, h.type), eq(erpnextSyncJobsTable.entityId, h.id),
      sql`${erpnextSyncJobsTable.payload} ? 'financeReviewHold'`)).limit(1);
    if (held) ctx.legacyHeld = true;
  }
  return { deal: row.deal, vehicle: row.vehicle, enrolled: !!row.enrolledId, invoice, ctx };
}

function policyInput(r: { kind: string; amountCents: number; category: string | null; sourceId: string | null; payerType: string | null; billingTreatment: string | null; customerChargeCents: number | null; reference: string; paymentMethod?: string | null }): FinancePolicyInput {
  return { kind: r.kind as FinancePolicyInput["kind"], amountCents: r.amountCents, category: r.category as FinancePolicyInput["category"],
    sourceId: r.sourceId, payerType: r.payerType as FinancePolicyInput["payerType"], billingTreatment: r.billingTreatment as FinancePolicyInput["billingTreatment"],
    customerChargeCents: r.customerChargeCents, reference: r.reference, paymentMethod: r.paymentMethod };
}

export async function createRequest(dealerId: number, dealId: number, actor: Actor, body: CreateRequestBody) {
  if (!actor.canEdit) fail("Finance edit permission is required to submit requests", 403);
  const amountCents = parseCents(body.amount)!;
  const customerChargeCents = body.billingTreatment === "customer_billed" ? parseCents(body.customerCharge) : null;
  if (body.kind !== "expense" && (body.category || body.billingTreatment)) fail("Category and billing treatment apply to expenses only", 400);
  if (body.kind === "expense" && (body.invoiceId || body.legacyPaymentId)) fail("Expenses are independent of invoices", 400);
  if (body.kind === "payment" && !body.paymentMethod) fail("Payment method is required", 400);
  if (body.kind === "payment" && !body.payerType) fail("Select the payer (customer or financier)", 400);
  if (body.kind === "expense" && !body.billingTreatment) fail("Choose dealer-paid or customer-billed", 400);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(76044, ${dealerId})`);
    const { config, revision, valid } = await loadConfig(tx, dealerId);
    const loaded = await loadContext(tx, dealerId, dealId, body.invoiceId, body.legacyPaymentId);
    if (!loaded.enrolled) fail("Enrol this deal in Sales Finance before submitting requests");
    loaded.ctx.configValid = valid;
    if (body.legacyPaymentId) {
      const [p] = await tx.select().from(paymentsTable).where(and(eq(paymentsTable.id, body.legacyPaymentId), eq(paymentsTable.dealerId, dealerId)));
      if (!p || p.invoiceId !== body.invoiceId) fail("Legacy receipt not found on the selected invoice", 404);
      if (Math.round(p.amount * 100) !== amountCents) fail("Amount must equal the legacy receipt being reconciled");
      // Reconciling an existing receipt never creates a second one.
      if (loaded.ctx.invoiceOutstandingCents != null) loaded.ctx.invoiceOutstandingCents += amountCents;
    }
    if (body.kind === "invoice" && body.invoiceId) {
      const [dupe] = await tx.select({ id: requests.id }).from(requests).where(and(eq(requests.dealerId, dealerId), eq(requests.kind, "invoice"),
        eq(requests.invoiceId, body.invoiceId), inArray(requests.status, ACTIVE)));
      if (dupe) fail(`Invoice already has an active request (#${dupe.id})`, 409);
    }
    if (body.legacyPaymentId) {
      const [dupe] = await tx.select({ id: requests.id }).from(requests).where(and(eq(requests.dealerId, dealerId),
        eq(requests.legacyPaymentId, body.legacyPaymentId), inArray(requests.status, ACTIVE)));
      if (dupe) fail(`Receipt already has an active request (#${dupe.id})`, 409);
    }
    const input = policyInput({ kind: body.kind, amountCents, category: body.category ?? null, sourceId: body.sourceId ?? null,
      payerType: body.payerType ?? null, billingTreatment: body.billingTreatment ?? null, customerChargeCents, reference: body.reference, paymentMethod: body.paymentMethod });
    const result = evaluateFinanceRequest(config, input, loaded.ctx);
    const source = config.sources.find((s) => s.id === body.sourceId) ?? null;
    const rule = body.kind === "expense" ? config.customerCharges?.find((r) => r.category === body.category) ?? null : null;
    const snapshot: SalesFinanceRequestSnapshot = {
      advancePolicy: loaded.ctx.advancePolicy,
      advanceApplications: body.kind === "invoice" ? loaded.ctx.advanceApplications : undefined,
      input: { ...body, amountCents, customerChargeCents, chargeNetCents: result.chargeNetCents, chargeVatCents: result.chargeVatCents },
      lines: result.lines, configRevision: revision, source,
      chargeRule: rule && body.billingTreatment === "customer_billed" ? { category: rule.category, incomeAccount: rule.incomeAccount, taxTreatment: rule.taxTreatment,
        vatRate: rule.vatRate, amountIncludesVat: rule.amountIncludesVat, approvalReference: rule.approvalReference } : null,
      accounts: Object.fromEntries(config.accounts.map((a) => [a.key, a.account])),
      invoice: loaded.invoice ? invoiceBasis(loaded.invoice) : null,
    };
    const status = result.policyBlocks.length ? "blocked" : "pending";
    const [row] = await tx.insert(requests).values({
      dealerId, dealId, invoiceId: body.invoiceId ?? null, kind: body.kind, category: body.category ?? null, date: body.date,
      amountCents, paymentMethod: body.paymentMethod ?? null, sourceId: body.sourceId ?? null, payerType: body.payerType ?? null,
      reference: body.reference.trim(), evidence: body.evidence?.trim() || null, billingTreatment: body.billingTreatment ?? null,
      customerChargeCents, legacyPaymentId: body.legacyPaymentId ?? null, snapshot, configRevision: revision,
      blockers: [...result.policyBlocks, ...result.blockers], status, requestedBy: actor.id,
    }).returning();
    await audit(tx, dealerId, actor, "create", row!.id, `Submitted ${body.kind} request #${row!.id} (${status})`, { snapshot, blockers: row!.blockers });
    return row!;
  });
}

export async function decideRequest(dealerId: number, requestId: number, actor: Actor, decision: "approve" | "reject", reason?: string) {
  if (!actor.canApprove) fail("Finance approve permission is required", 403);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(76044, ${dealerId})`);
    const [r] = await tx.select().from(requests).where(and(eq(requests.id, requestId), eq(requests.dealerId, dealerId))).for("update");
    if (!r) fail("Request not found", 404);
    if (r.requestedBy === actor.id) fail("A different Finance approver must decide this request.", 403);
    if (decision === "reject") {
      if (!["pending", "blocked"].includes(r.status)) fail(`Request is ${r.status}; only pending or blocked requests can be rejected`, 409);
      if (!reason?.trim()) fail("A rejection reason is required", 400);
      const [u] = await tx.update(requests).set({ status: "rejected", reviewedBy: actor.id, reviewedAt: new Date(), rejectionReason: reason.trim(), updatedAt: new Date() })
        .where(eq(requests.id, r.id)).returning();
      await audit(tx, dealerId, actor, "reject", r.id, `Rejected request #${r.id}; no financial effect`, { reason });
      return u!;
    }
    if (r.status !== "pending") fail(`Request is ${r.status}; it cannot be approved`, 409);
    const { config, revision, valid } = await loadConfig(tx, dealerId);
    if (revision !== r.configRevision) fail("Finance mappings changed after submission. This request is invalidated: reject it and submit a new one.", 409);
    const loaded = await loadContext(tx, dealerId, r.dealId, r.invoiceId, r.legacyPaymentId, r.id);
    if (!loaded.enrolled) fail("Deal is no longer enrolled", 409);
    loaded.ctx.configValid = valid;
    if (r.legacyPaymentId && loaded.ctx.invoiceOutstandingCents != null) loaded.ctx.invoiceOutstandingCents += r.amountCents;
    const result = evaluateFinanceRequest(config, policyInput(r), loaded.ctx);
    if (result.policyBlocks.length) fail(result.policyBlocks.join(" "));
    if (result.blockers.length) fail(result.blockers.join(" "));
    const norm = (ls: { account: string; debit: number; credit: number; purpose: string }[]) => ls.map((l) => `${l.account}|${Math.round(l.debit * 100)}|${Math.round(l.credit * 100)}|${l.purpose}`).join("\n");
    if (norm(result.lines) !== norm(r.snapshot.lines)) {
      fail("The GL lines no longer match the submitted snapshot (invoice or mapping changed). Submit a new request.", 409);
    }
    if (JSON.stringify(loaded.ctx.advanceApplications ?? []) !== JSON.stringify(r.snapshot.advanceApplications ?? []) && r.kind === "invoice") {
      fail("Available deposits changed after submission. Reject and resubmit to review the updated deposit application.", 409);
    }
    if (r.snapshot.invoice) {
      const drift = invoiceDrift(r.snapshot.invoice, loaded.invoice);
      if (drift.length) fail(`Invoice changed after submission (${drift.join(", ")}). Submit a new request.`, 409);
    }
    const attempt = r.postAttempts + 1;
    const [job] = await tx.insert(erpnextSyncJobsTable).values({ dealerId, direction: "outbound", doctype: SALES_FINANCE_DOCTYPE, operation: "insert",
      entityType: "sales_finance_request", entityId: r.id, status: "queued", dedupeKey: `sfr:${dealerId}:${r.id}:${attempt}`,
      payload: { requestId: r.id, attempt, authorizedBy: actor.id, authorizedAt: new Date().toISOString(), lines: r.snapshot.lines, configRevision: r.configRevision } }).returning();
    const [u] = await tx.update(requests).set({ status: "approved", reviewedBy: actor.id, reviewedAt: new Date(), erpJobId: job!.id,
      erpRemoteKey: remoteKey(r), postAttempts: attempt, updatedAt: new Date() }).where(eq(requests.id, r.id)).returning();
    await audit(tx, dealerId, actor, "approve", r.id, `Approved request #${r.id}; durable ERPNext posting queued (job #${job!.id})`, { lines: r.snapshot.lines });
    return u!;
  });
}

export async function retryRequest(dealerId: number, requestId: number, actor: Actor) {
  if (!actor.canApprove) fail("Finance approve permission is required", 403);
  return db.transaction(async (tx) => {
    const [r] = await tx.select().from(requests).where(and(eq(requests.id, requestId), eq(requests.dealerId, dealerId))).for("update");
    if (!r) fail("Request not found", 404);
    if (r.status !== "failed") fail(`Only failed postings can be retried (request is ${r.status})`, 409);
    const attempt = r.postAttempts + 1;
    const [job] = await tx.insert(erpnextSyncJobsTable).values({ dealerId, direction: "outbound", doctype: SALES_FINANCE_DOCTYPE, operation: "insert",
      entityType: "sales_finance_request", entityId: r.id, status: "queued", dedupeKey: `sfr:${dealerId}:${r.id}:${attempt}`,
      payload: { requestId: r.id, attempt, retriedBy: actor.id, lines: r.snapshot.lines, configRevision: r.configRevision } }).returning();
    const [u] = await tx.update(requests).set({ status: "approved", erpJobId: job!.id, postAttempts: attempt, updatedAt: new Date() })
      .where(eq(requests.id, r.id)).returning();
    await audit(tx, dealerId, actor, "retry", r.id, `Retried posting for request #${r.id} (attempt ${attempt}); deterministic keys prevent duplicates`);
    return u!;
  });
}

/** Remote side, injectable for tests. Defaults wrap the existing ERPNext handlers. */
export type SalesFinanceRemote = {
  postInvoice(job: ErpnextSyncJob, invoiceId: number, accounts: { incomeAccount: string; taxAccount: string | null }): Promise<string | null>;
  postPayment(job: ErpnextSyncJob, paymentId: number, accounts: { paidTo: string; receivable: string }): Promise<string | null>;
  postJournal(dealerId: number, requestId: number, key: string, date: string, lines: SalesFinanceRequestSnapshot["lines"]): Promise<string>;
};

async function ensureChargeInvoice(r: SalesFinanceRequest): Promise<number> {
  if (r.chargeInvoiceId) return r.chargeInvoiceId;
  return db.transaction(async (tx) => {
    const [locked] = await tx.select().from(requests).where(eq(requests.id, r.id)).for("update");
    if (locked!.chargeInvoiceId) return locked!.chargeInvoiceId;
    const [deal] = await tx.select().from(dealsTable).where(and(eq(dealsTable.id, r.dealId), eq(dealsTable.dealerId, r.dealerId)));
    const net = Number(r.snapshot.input["chargeNetCents"] ?? 0), vat = Number(r.snapshot.input["chargeVatCents"] ?? 0);
    const rule = r.snapshot.chargeRule!;
    const [inv] = await tx.insert(invoicesTable).values({ dealerId: r.dealerId, invoiceNumber: "PENDING", customerId: deal?.customerId ?? null,
      customerName: deal?.customerName ?? "Customer", dealId: r.dealId, kind: "final", status: "issued",
      description: `Customer charge - ${r.category} (SFR #${r.id})`, amount: (net + vat) / 100, currency: "GYD",
      taxLines: vat > 0 ? [{ code: "VAT", name: "VAT", kind: "percent", rate: rule.vatRate, amount: vat / 100 }] : [] }).returning();
    await tx.update(invoicesTable).set({ invoiceNumber: `CHG-${new Date().getUTCFullYear()}-${String(inv!.id).padStart(4, "0")}` }).where(eq(invoicesTable.id, inv!.id));
    await tx.update(requests).set({ chargeInvoiceId: inv!.id, updatedAt: new Date() }).where(eq(requests.id, r.id));
    return inv!.id;
  });
}

async function ensureLocalPayment(r: SalesFinanceRequest): Promise<number> {
  if (r.legacyPaymentId) return r.legacyPaymentId; // reconcile, never a second receipt
  if (r.paymentId) return r.paymentId;
  const ref = paymentReference(r);
  const method = r.paymentMethod ?? "bank_transfer";
  // Crash window: applyPayment committed but paymentId not yet stored. Adopt
  // only an exact match on dealer, invoice, amount, method and reference.
  const same = await db.select().from(paymentsTable).where(and(eq(paymentsTable.dealerId, r.dealerId), eq(paymentsTable.reference, ref)));
  const adopt = same.find((p) => p.invoiceId === r.invoiceId && Math.round(p.amount * 100) === r.amountCents && p.method === method);
  if (same.length && !adopt) throw new Error("A receipt with this request's idempotency reference exists but does not match the approved invoice, amount or method. Not adopted; Finance must investigate.");
  let paymentId = adopt?.id;
  if (!paymentId) {
    const [invoice] = await db.select().from(invoicesTable).where(and(eq(invoicesTable.id, r.invoiceId!), eq(invoicesTable.dealerId, r.dealerId)));
    if (!invoice) throw new Error("Invoice no longer exists");
    const [u] = await db.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, r.reviewedBy ?? r.requestedBy));
    // Existing transactional guards: invoice row lock, overpayment, duplicate reference.
    const res = await applyPayment({ invoice, amount: r.amountCents / 100, method, reference: ref,
      receivedBy: u?.name ?? "Finance", erpSync: false });
    paymentId = res.payment.id;
  }
  await db.update(requests).set({ paymentId, updatedAt: new Date() }).where(eq(requests.id, r.id));
  return paymentId;
}

const PAYMENT_GUARD_TEXT: Record<string, string> = {
  overpayment: "Invoice balance changed; this payment would overpay it. Nothing was recorded.",
  invoice_already_paid: "Invoice is already fully paid. Nothing was recorded.",
  invoice_void: "Invoice is void. Nothing was recorded.",
  duplicate_reference: "A receipt with this reference already exists.",
};

const ERP_DOCTYPE: Record<string, string> = { expense: "Journal Entry", invoice: "Sales Invoice", payment: "Payment Entry" };

/** Verify the approved invoice basis under the invoice row lock. Mutators
 * (PATCH /invoices) refuse frozen invoices, so the basis cannot drift between
 * this check and the remote call. */
async function assertInvoiceUnchanged(r: SalesFinanceRequest, invoiceId: number, basis: SalesFinanceRequestSnapshot["invoice"]) {
  if (!basis) throw new Error("Approval snapshot has no invoice basis; not posted.");
  await db.transaction(async (tx) => {
    const [live] = await tx.select().from(invoicesTable).where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.dealerId, r.dealerId))).for("update");
    const drift = invoiceDrift(basis, live);
    if (drift.length) throw new Error(`Invoice changed after approval (${drift.join(", ")}); nothing was posted. Reject and resubmit.`);
  });
}

export async function executeRequestPosting(job: ErpnextSyncJob, remote: SalesFinanceRemote): Promise<{ docName: string | null }> {
  // Serialize the complete remote-create/ref/submit window, not just the local
  // receipt write. This also coordinates with the legacy hold/enrolment lock.
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(76042, ${job.dealerId})`);
    await tx.execute(sql`select pg_advisory_xact_lock(76045, ${job.entityId})`);
    return executeRequestPostingLocked(job, remote);
  });
}

async function executeRequestPostingLocked(job: ErpnextSyncJob, remote: SalesFinanceRemote): Promise<{ docName: string | null }> {
  const attempt = Number(job.payload["attempt"]);
  // CAS claim: only the job for the current attempt may move approved/posting -> posting.
  const [claimed] = await db.update(requests).set({ status: "posting", updatedAt: new Date() }).where(and(
    eq(requests.id, job.entityId), eq(requests.dealerId, job.dealerId), inArray(requests.status, ["approved", "posting"]),
    eq(requests.postAttempts, attempt))).returning();
  if (!claimed) {
    const [cur] = await db.select().from(requests).where(and(eq(requests.id, job.entityId), eq(requests.dealerId, job.dealerId)));
    if (!cur) throw new ErpnextError("Sales finance request not found", 422, "http");
    if (cur.status === "posted") return { docName: cur.erpDocName?.split(" + ")[0] ?? null }; // idempotent duplicate delivery
    throw new ErpnextError(`Request #${cur.id} is ${cur.status}; posting is not authorized for this job`, 422, "http");
  }
  const r = claimed;
  try {
    if (!(await isPilotDealer(r.dealerId))) throw new Error("Dealership is unavailable; not posted.");
    const held = await loadContext(db, r.dealerId, r.dealId, r.invoiceId, r.legacyPaymentId);
    if (held.ctx.legacyHeld) throw new Error("Linked legacy record is under Finance review hold; not posted.");
    const isAdvance = held.ctx.invoice?.kind === "reservation";
    if (isAdvance && (!held.ctx.advancePolicy || r.snapshot.advancePolicy !== held.ctx.advancePolicy || r.kind !== "payment")) {
      throw new Error("This advance request has no approved deposit posting basis. Reject and resubmit; nothing was posted.");
    }
    if (r.kind === "invoice" && !["committed", "delivered"].includes(held.ctx.dealStage ?? "") &&
        !(held.ctx.dealStage === "desking" && held.ctx.hasInvoiceReservation)) {
      throw new Error("The deal no longer holds its invoiced VIN; nothing was posted. Review the reservation.");
    }
    const lines = r.snapshot.lines;
    const acct = r.snapshot.accounts;
    let docName: string | null = null;
    const need = (name: string | null | undefined, what: string): string => {
      if (!name || !String(name).trim()) throw new Error(`ERPNext returned no ${what} document name; not marked posted.`);
      return name;
    };
    if (r.kind === "invoice") {
      if (r.snapshot.advancePolicy) {
        if (held.ctx.unresolvedAdvance) throw new Error("Reconcile unresolved deposit postings before posting the final invoice.");
        const expected = held.ctx.fullSaleAmountCents;
        if (r.snapshot.invoice?.amountCents !== expected) throw new Error("Sale value changed after approval; Finance must reconcile before posting.");
      }
      const income = lines.find((l) => l.credit > 0 && l.purpose === "Vehicle sale income")?.account;
      if (!income) throw new Error("Snapshot is missing the income line");
      await assertInvoiceUnchanged(r, r.invoiceId!, r.snapshot.invoice);
      const applications = r.snapshot.advanceApplications ?? [];
      if (applications.length) {
        const refreshed = await loadContext(db, r.dealerId, r.dealId, r.invoiceId, null, r.id);
        if (JSON.stringify(refreshed.ctx.advanceApplications ?? []) !== JSON.stringify(applications)) {
          throw new Error("Approved deposit allocation changed; Finance reconciliation is required before applying deposits.");
        }
      }
      docName = need(await remote.postInvoice(job, r.invoiceId!, { incomeAccount: income, taxAccount: acct["vatOutput"] || null }), "Sales Invoice");
      if (applications.length) {
        const journal = await remote.postJournal(r.dealerId, r.id, remoteKey(r), r.date,
          lines.filter(l => ["Customer deposit applied", "Deposit credit against final invoice"].includes(l.purpose)));
        await ensureDepositCredit(r);
        docName = `${docName} + ${need(journal, "deposit application Journal Entry")}`;
      }
    } else if (r.kind === "payment") {
      await assertInvoiceUnchanged(r, r.invoiceId!, r.snapshot.invoice);
      if (isAdvance) {
        // Remote first: never mark a reservation paid/hold stock on a failed
        // ERP journal. Retrying adopts the deterministic journal and receipt.
        const current = await loadContext(db, r.dealerId, r.dealId, r.invoiceId, r.legacyPaymentId, r.id);
        const [adoptable] = await db.select().from(paymentsTable).where(and(eq(paymentsTable.dealerId, r.dealerId),
          eq(paymentsTable.invoiceId, r.invoiceId!), eq(paymentsTable.reference, paymentReference(r))));
        if (current.ctx.finalSaleStarted && !adoptable && !r.paymentId && !r.legacyPaymentId) {
          throw new Error("The final sale has started. Reconcile this request and record further receipts against the final invoice.");
        }
        if (!r.paymentId && !r.legacyPaymentId && !adoptable && current.ctx.invoiceOutstandingCents! < r.amountCents) {
          throw new Error("Deposit balance changed; this receipt would overpay the reservation.");
        }
        docName = need(await remote.postJournal(r.dealerId, r.id, remoteKey(r), r.date, lines), "deposit Journal Entry");
        await ensureLocalPayment(r);
      } else {
        const paymentId = await ensureLocalPayment(r);
        docName = need(await remote.postPayment(job, paymentId, { paidTo: r.snapshot.source!.account, receivable: acct["receivables"]! }), "Payment Entry");
      }
    } else {
      docName = need(await remote.postJournal(r.dealerId, r.id, remoteKey(r), r.date, lines.slice(0, 2)), "Journal Entry");
      if (r.billingTreatment === "customer_billed") {
        const chargeId = await ensureChargeInvoice(r);
        const si = need(await remote.postInvoice(job, chargeId, { incomeAccount: r.snapshot.chargeRule!.incomeAccount, taxAccount: acct["vatOutput"] || null }), "charge Sales Invoice");
        docName = `${docName} + ${si}`;
      }
    }
    // Remote success is the truth: a concurrent loser may have marked failed.
    await db.update(requests).set({ status: "posted", postedAt: new Date(), erpDocName: docName, erpDoctype: isAdvance ? "Journal Entry" : ERP_DOCTYPE[r.kind],
      lastError: null, updatedAt: new Date() }).where(and(eq(requests.id, r.id), inArray(requests.status, ["posting", "failed"])));
    await audit(db, r.dealerId, null, "post", r.id, `Posted request #${r.id} to ERPNext (${docName})`);
    return { docName: docName.split(" + ")[0] ?? null };
  } catch (err) {
    const message = err instanceof PaymentGuardError ? PAYMENT_GUARD_TEXT[err.code] ?? err.code : err instanceof Error ? err.message : String(err);
    // CAS: never regress a terminal posted state.
    const [marked] = await db.update(requests).set({ status: "failed", lastError: message.slice(0, 1000), updatedAt: new Date() })
      .where(and(eq(requests.id, r.id), eq(requests.status, "posting"))).returning({ id: requests.id });
    if (!marked) {
      const [cur] = await db.select().from(requests).where(eq(requests.id, r.id));
      if (cur?.status === "posted") return { docName: cur.erpDocName?.split(" + ")[0] ?? null };
    }
    await audit(db, r.dealerId, null, "fail", r.id, `Posting failed for request #${r.id}: ${message.slice(0, 200)}`);
    // Dead-letter the job; Finance retries explicitly with the same deterministic keys.
    throw new ErpnextError(message, 422, "http");
  }
}

/** Gate for the exported authorized ERPNext wrappers: only a claimed request
 * in the pilot dealer, with no Finance hold on the entity, may post. Returns
 * the TRUSTED posting context derived from the immutable approval snapshot. */
export async function assertAuthorizedPosting(dealerId: number, requestId: number, entity?: { type: string; id: number }): Promise<AuthorizedPosting> {
  const [r] = await db.select().from(requests).where(and(eq(requests.id, requestId), eq(requests.dealerId, dealerId)));
  if (!r || r.status !== "posting") throw new ErpnextError("Posting is not authorized: no claimed sales finance request", 422, "http");
  if (!(await isPilotDealer(dealerId))) throw new ErpnextError("Posting dealership is unavailable", 422, "http");
  if (entity) {
    const allowed = entity.type === "invoice" ? [r.invoiceId, r.chargeInvoiceId] : entity.type === "payment" ? [r.paymentId, r.legacyPaymentId] : [requestId];
    if (!allowed.includes(entity.id)) throw new ErpnextError(`Posting is not authorized for ${entity.type} #${entity.id}`, 422, "http");
    const [held] = await db.select({ id: erpnextSyncJobsTable.id }).from(erpnextSyncJobsTable).where(and(eq(erpnextSyncJobsTable.dealerId, dealerId),
      eq(erpnextSyncJobsTable.entityType, entity.type), eq(erpnextSyncJobsTable.entityId, entity.id), sql`${erpnextSyncJobsTable.payload} ? 'financeReviewHold'`)).limit(1);
    if (held) throw new ErpnextError("Entity is under Finance review hold; not posted", 422, "http");
  }
  const snap = r.snapshot;
  const isCharge = entity?.type === "invoice" && entity.id === r.chargeInvoiceId;
  return {
    requestId: r.id, date: r.date, receivable: snap.accounts["receivables"] ?? "", vatOutput: snap.accounts["vatOutput"] || null,
    incomeAccount: entity?.type !== "invoice" ? null : isCharge ? snap.chargeRule?.incomeAccount ?? null
      : snap.lines.find((l) => l.credit > 0 && l.purpose === "Vehicle sale income")?.account ?? null,
    paidTo: snap.source?.account ?? null,
    journalInvoiceId: r.kind === "invoice" && snap.advanceApplications?.length ? r.invoiceId : null,
    journalLines: r.kind === "expense" ? snap.lines.slice(0, 2)
      : r.kind === "payment" && snap.advancePolicy && snap.invoice?.kind === "reservation" ? snap.lines
      : r.kind === "invoice" && snap.advanceApplications?.length
        ? snap.lines.filter(l => ["Customer deposit applied", "Deposit credit against final invoice"].includes(l.purpose)) : [],
  };
}

async function ensureDepositCredit(r: SalesFinanceRequest) {
  const amountCents = (r.snapshot.advanceApplications ?? []).reduce((s, a) => s + a.amountCents, 0);
  const reference = `${remoteKey(r)} | NON-CASH DEPOSIT APPLICATION`;
  const [existing] = await db.select().from(paymentsTable).where(and(eq(paymentsTable.dealerId, r.dealerId), eq(paymentsTable.reference, reference)));
  if (existing) {
    if (existing.invoiceId !== r.invoiceId || Math.round(existing.amount * 100) !== amountCents || existing.method !== "account_credit") {
      throw new Error("Existing deposit application does not match its approved basis.");
    }
    return;
  }
  const [invoice] = await db.select().from(invoicesTable).where(and(eq(invoicesTable.dealerId, r.dealerId), eq(invoicesTable.id, r.invoiceId!)));
  if (!invoice) throw new Error("Final invoice missing");
  await applyPayment({ invoice, amount: amountCents / 100, method: "account_credit", reference, receivedBy: "Finance — deposit application", erpSync: false });
}

export async function dealFinanceSummary(dealerId: number, dealId: number) {
  const loaded = await loadContext(db, dealerId, dealId, null, null);
  const invoices = await db.select().from(invoicesTable).where(and(eq(invoicesTable.dealerId, dealerId), eq(invoicesTable.dealId, dealId)));
  const live = invoices.filter((i) => i.status !== "void");
  const payments = live.length ? await db.select().from(paymentsTable).where(and(eq(paymentsTable.dealerId, dealerId), inArray(paymentsTable.invoiceId, live.map((i) => i.id)))) : [];
  const rows = await db.select().from(requests).where(and(eq(requests.dealerId, dealerId), eq(requests.dealId, dealId))).orderBy(desc(requests.id));
  const refs = live.length ? await db.select().from(erpnextRefsTable).where(and(eq(erpnextRefsTable.dealerId, dealerId), eq(erpnextRefsTable.entityType, "invoice"), inArray(erpnextRefsTable.entityId, live.map((i) => i.id)))) : [];
  const balanceInvoices = loaded.ctx.advancePolicy && live.some(i => i.kind === "final")
    ? live.filter(i => i.kind === "final") : live;
  const invoicedCents = balanceInvoices.reduce((s, i) => s + Math.round(i.amount * 100), 0);
  const paidCents = payments.filter(p => balanceInvoices.some(i => i.id === p.invoiceId)).reduce((s, p) => s + Math.round(p.amount * 100), 0);
  const pending = (kind: string) => rows.filter((r) => r.kind === kind && ["pending", "approved", "posting"].includes(r.status)).reduce((s, r) => s + r.amountCents, 0);
  return {
    deal: { id: loaded.deal.id, customerName: loaded.deal.customerName ?? "Customer", stage: loaded.deal.stage, enrolled: loaded.enrolled,
      vehicle: loaded.vehicle ? `${loaded.vehicle.make} ${loaded.vehicle.model}` : "VIN not assigned", vin: loaded.vehicle?.vin ?? "" },
    totals: { invoicedCents, paidCents, outstandingCents: invoicedCents - paidCents, pendingInvoiceCents: pending("invoice"),
      pendingPaymentCents: pending("payment"), pendingExpenseCents: pending("expense"),
      postedExpenseCents: rows.filter((r) => r.kind === "expense" && r.status === "posted").reduce((s, r) => s + r.amountCents, 0) },
    invoices: live.map((i) => {
      const paid = payments.filter((p) => p.invoiceId === i.id).reduce((s, p) => s + Math.round(p.amount * 100), 0);
      return { id: i.id, invoiceNumber: i.invoiceNumber, kind: i.kind, status: i.status, amountCents: Math.round(i.amount * 100), paidCents: paid,
        erpPosted: refs.some((f) => f.entityId === i.id) };
    }),
    payments: payments.map((p) => ({ id: p.id, invoiceId: p.invoiceId, amountCents: Math.round(p.amount * 100), method: p.method, reference: p.reference ?? "" })),
    requests: await presentRequests(dealerId, rows),
  };
}

export async function presentRequests(dealerId: number, rows: SalesFinanceRequest[]) {
  const userIds = [...new Set(rows.flatMap((r) => [r.requestedBy, r.reviewedBy]).filter((x): x is number => x != null))];
  const users = userIds.length ? await db.select({ id: usersTable.id, name: usersTable.name, email: usersTable.email }).from(usersTable).where(inArray(usersTable.id, userIds)) : [];
  const ids = rows.map((r) => String(r.id));
  const logs = ids.length ? await db.select().from(auditLogsTable).where(and(eq(auditLogsTable.dealerId, dealerId), eq(auditLogsTable.entityType, "sales_finance_request"), inArray(auditLogsTable.entityId, ids))).orderBy(auditLogsTable.createdAt) : [];
  const name = (id: number | null) => { const u = users.find((x) => x.id === id); return u ? (u.name || u.email || `User #${id}`) : null; };
  const { revision, config, valid } = await loadConfig(db, dealerId);
  return Promise.all(rows.map(async (r) => {
    // Refresh only blocked advance guidance. Preserve the original submission
    // snapshot/audit and every approved or posted request unchanged.
    let lines = r.snapshot.lines;
    let blockers = r.blockers;
    if (r.status === "blocked" && r.snapshot.invoice?.kind === "reservation" &&
        ["invoice", "payment"].includes(r.kind)) {
      const loaded = await loadContext(db, dealerId, r.dealId, r.invoiceId, r.legacyPaymentId, r.id);
      if (loaded.ctx.invoice?.kind === "reservation") {
        loaded.ctx.configValid = valid;
        const result = evaluateFinanceRequest(config, policyInput(r), loaded.ctx);
        lines = result.lines;
        blockers = [...result.policyBlocks, ...result.blockers];
        if (loaded.ctx.advancePolicy && r.kind === "payment") {
          blockers.push("This request was submitted before the advance policy was approved. A different Finance approver must reject it; submit a replacement payment request with the correct receiving source for independent approval.");
        }
      }
    }
    return ({
    id: r.id, dealId: r.dealId, invoiceId: r.invoiceId, kind: r.kind, category: r.category, date: r.date, amountCents: r.amountCents,
    paymentMethod: r.paymentMethod, sourceId: r.sourceId, sourceLabel: r.snapshot.source?.label ?? null, sourceKind: r.snapshot.source?.kind ?? null,
    payerType: r.payerType, reference: r.reference, evidence: r.evidence, billingTreatment: r.billingTreatment, customerChargeCents: r.customerChargeCents,
    legacyPaymentId: r.legacyPaymentId, invoiceNumber: r.snapshot.invoice?.invoiceNumber ?? null, lines, blockers,
    stale: r.status === "pending" && r.configRevision !== revision, configRevision: r.configRevision, status: r.status,
    requestedBy: r.requestedBy, requestedByName: name(r.requestedBy), requestedAt: r.requestedAt.toISOString(),
    reviewedBy: r.reviewedBy, reviewedByName: name(r.reviewedBy), reviewedAt: r.reviewedAt?.toISOString() ?? null, rejectionReason: r.rejectionReason,
    paymentId: r.paymentId, chargeInvoiceId: r.chargeInvoiceId, erpJobId: r.erpJobId, erpDoctype: r.erpDoctype, erpDocName: r.erpDocName,
    erpRemoteKey: r.erpRemoteKey, postAttempts: r.postAttempts, lastError: r.lastError, postedAt: r.postedAt?.toISOString() ?? null,
    audit: logs.filter((l) => l.entityId === String(r.id)).map((l) => ({ id: l.id, action: l.action, summary: l.summary, actorName: l.actorName ?? name(l.actorUserId) ?? "System", at: l.createdAt.toISOString() })),
    });
  }));
}

export async function listQueue(dealerId: number, status?: string) {
  const rows = await db.select().from(requests).where(and(eq(requests.dealerId, dealerId), ...(status ? [eq(requests.status, status)] : []))).orderBy(desc(requests.id)).limit(300);
  return presentRequests(dealerId, rows);
}

export async function isPilotEnrolledInvoice(dealerId: number, dealId: number | null): Promise<boolean> {
  if (dealId == null) return false;
  const [w] = await db.select({ id: workflows.id }).from(workflows).where(and(eq(workflows.dealerId, dealerId), eq(workflows.dealId, dealId)));
  return !!w;
}
/** Dealer-wide: any pilot SALES invoice (enrolled or not) needs a request. */
export async function requiresSalesFinanceApproval(inv: { dealerId: number; dealId: number | null; description?: string | null }): Promise<boolean> {
  return isPilotSalesInvoice(db, inv);
}
