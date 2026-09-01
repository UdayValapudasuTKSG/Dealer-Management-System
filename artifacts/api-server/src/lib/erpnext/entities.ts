import { and, eq } from "drizzle-orm";
import {
  db,
  customersTable,
  invoicesTable,
  paymentsTable,
  dealsTable,
  vehiclesTable,
  vehicleModelGlCodesTable,
  normalizeModelKey,
  erpnextSyncJobsTable,
  erpnextRefsTable,
  type Customer,
  type ErpnextConnection,
  type ErpnextSyncJob,
} from "@workspace/db";
import { logger } from "../logger";
import { ErpnextError, type ErpnextClient } from "./client";
import { clientFor, getErpnextConnection } from "./connection";
import {
  enqueueErpnextSync,
  getErpnextRef,
  registerErpnextSyncHandler,
  saveErpnextRef,
} from "./sync";
import { registerErpnextInboundHandler } from "../../routes/webhooks";

// ---------------------------------------------------------------------------
// ERPNext entity sync (Task: customers, invoices & payments).
//  - Customers are two-way: AURA create/update → ERPNext Customer; ERPNext
//    Customer webhook edits flow back (last-write-wins with conflict log).
//  - Financial documents are one-way AURA → ERPNext: invoices post as
//    submitted Sales Invoices (void mirrors cancel), payments/refunds post
//    as Payment Entries allocated against the mapped Sales Invoice.
// All I/O rides the durable sync-job queue — nothing here runs in a request
// path; enqueue helpers are fire-safe (log, never throw).
// ---------------------------------------------------------------------------

/** Readable, non-retryable configuration problem (dead-letters immediately
 * with the reason in the sync log; fixable via Settings → ERPNext + Retry). */
function configError(message: string): ErpnextError {
  return new ErpnextError(message, 422, "http");
}

/** Retryable "dependency not synced yet" wait state. */
function waitingFor(message: string): ErpnextError {
  return new ErpnextError(message, 0, "network");
}

async function requireConnection(dealerId: number): Promise<ErpnextConnection> {
  const conn = await getErpnextConnection(dealerId);
  if (!conn) throw waitingFor("ERPNext is not connected for this dealership");
  return conn;
}

// ————————————————————————————————————————————————— Customers (outbound) ——

function customerDoc(c: Customer): Record<string, unknown> {
  return {
    customer_name: c.name,
    customer_type: c.accountType === "business" ? "Company" : "Individual",
    email_id: c.email ?? "",
    mobile_no: c.phone ?? "",
    tax_id: c.taxNumber ?? "",
    // Soft-deleted or GDPR-erased AURA accounts disable the counterpart.
    disabled: c.deletedAt || c.erasedAt ? 1 : 0,
  };
}

/** Push one AURA customer to ERPNext: update the mapped doc, else match an
 * existing ERPNext Customer by email/phone (backfill dedupe), else insert. */
async function pushCustomer(
  dealerId: number,
  customerId: number,
  client: ErpnextClient,
): Promise<string> {
  const [customer] = await db
    .select()
    .from(customersTable)
    .where(
      and(eq(customersTable.id, customerId), eq(customersTable.dealerId, dealerId)),
    );
  if (!customer) throw configError(`Customer #${customerId} no longer exists in AURA`);

  const doc = customerDoc(customer);
  const existing = await getErpnextRef(dealerId, "customer", customerId, "Customer");
  if (existing) {
    await client.updateDoc("Customer", existing, doc);
    return existing;
  }

  // Backfill-safe matching: same email, then same phone, avoids duplicates
  // for records that existed in ERPNext before the integration.
  let matched: string | null = null;
  if (customer.email) {
    const rows = await client.listDocs<{ name: string }>("Customer", {
      filters: [["Customer", "email_id", "=", customer.email]],
      fields: ["name"],
      limit: 1,
    });
    matched = rows[0]?.name ?? null;
  }
  if (!matched && customer.phone) {
    const rows = await client.listDocs<{ name: string }>("Customer", {
      filters: [["Customer", "mobile_no", "=", customer.phone]],
      fields: ["name"],
      limit: 1,
    });
    matched = rows[0]?.name ?? null;
  }
  if (matched) {
    await client.updateDoc("Customer", matched, doc);
    await saveErpnextRef(dealerId, "customer", customerId, "Customer", matched);
    return matched;
  }
  const created = await client.insertDoc("Customer", doc);
  await saveErpnextRef(dealerId, "customer", customerId, "Customer", created.name);
  return created.name;
}

async function handleCustomerJob(job: ErpnextSyncJob): Promise<{ docName: string | null }> {
  const conn = await requireConnection(job.dealerId);
  const docName = await pushCustomer(job.dealerId, job.entityId, clientFor(conn));
  return { docName };
}

// —————————————————————————————————————————————— Sales Invoices (one-way) ——

/** Resolve (or create) the ERPNext Customer doc for an invoice's customer. */
async function resolveInvoiceCustomer(
  dealerId: number,
  customerId: number | null,
  customerName: string,
  client: ErpnextClient,
): Promise<string> {
  if (customerId != null) {
    const ref = await getErpnextRef(dealerId, "customer", customerId, "Customer");
    if (ref) return ref;
    return pushCustomer(dealerId, customerId, client);
  }
  // No linked AURA account — find or create an ERPNext Customer by name.
  const rows = await client.listDocs<{ name: string }>("Customer", {
    filters: [["Customer", "customer_name", "=", customerName]],
    fields: ["name"],
    limit: 1,
  });
  if (rows[0]) return rows[0].name;
  const created = await client.insertDoc("Customer", {
    customer_name: customerName,
    customer_type: "Individual",
  });
  return created.name;
}

/** Deterministic reconciliation key stored in `remarks` — lets a retry find
 * a doc that was created remotely before the local ref row was persisted
 * (crash between insert and saveErpnextRef), instead of duplicating it. */
function invoiceRemarks(inv: { invoiceNumber: string; kind: string }): string {
  return `AURA ${inv.invoiceNumber} (${inv.kind})`;
}
function paymentRemarks(paymentId: number, invoiceNumber: string): string {
  return `AURA payment #${paymentId} · invoice ${invoiceNumber}`;
}

/** Find a previously created doc by its deterministic remarks key. */
async function reconcileByRemarks(
  client: ErpnextClient,
  doctype: string,
  remarks: string,
): Promise<string | null> {
  const rows = await client.listDocs<{ name: string }>(doctype, {
    filters: [[doctype, "remarks", "=", remarks]],
    fields: ["name"],
    limit: 1,
  });
  return rows[0]?.name ?? null;
}

/** ERPNext requires every Sales Invoice line to carry an `item_code`. AURA
 * sells whole vehicles/services as one line, so we maintain a single
 * non-stock service Item and reuse it for all invoices. */
const AURA_SALES_ITEM = "AURA-SALE";
async function ensureSalesItem(client: ErpnextClient): Promise<string> {
  try {
    await client.getDoc("Item", AURA_SALES_ITEM);
    return AURA_SALES_ITEM;
  } catch (err) {
    if (!(err instanceof ErpnextError) || err.kind !== "not_found") throw err;
  }
  await client.insertDoc("Item", {
    item_code: AURA_SALES_ITEM,
    item_name: "AURA dealership sale",
    item_group: "All Item Groups",
    stock_uom: "Nos",
    is_stock_item: 0,
    is_sales_item: 1,
  });
  return AURA_SALES_ITEM;
}

/** Submit the doc if it is still a draft (idempotent across retries). */
async function ensureSubmitted(
  client: ErpnextClient,
  doctype: string,
  name: string,
): Promise<void> {
  const doc = await client.getDoc<{ docstatus?: number }>(doctype, name);
  if ((doc.docstatus ?? 0) === 0) await client.submitDoc(doctype, name);
}

/** Normalize an optional date-only due date for ERPNext.
 * Missing/malformed legacy values are omitted so ERPNext can apply payment
 * terms. A valid date before the posting date is clamped to posting date. */
export function normalizeErpnextDueDate(
  value: string | null | undefined,
  postingDate: string,
): string | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    return undefined;
  }
  return value < postingDate ? postingDate : value;
}

/**
 * Resolve the income account for an invoice: when the invoice belongs to a
 * deal whose vehicle's normalized make/model has a Finance GL-code mapping,
 * that mapping wins; otherwise the dealer-wide default income account is
 * used. Never falls back to a DIFFERENT model's code.
 */
async function resolveInvoiceIncomeAccount(
  dealerId: number,
  invoice: { dealId: number | null },
  defaultAccount: string | null,
): Promise<{
  account: string | null;
  source: "model-mapping" | "dealer-default";
  modelKey: string | null;
}> {
  if (invoice.dealId != null) {
    const [deal] = await db
      .select({ vehicleId: dealsTable.vehicleId })
      .from(dealsTable)
      .where(
        and(eq(dealsTable.id, invoice.dealId), eq(dealsTable.dealerId, dealerId)),
      );
    if (deal?.vehicleId != null) {
      const [vehicle] = await db
        .select({ make: vehiclesTable.make, model: vehiclesTable.model })
        .from(vehiclesTable)
        .where(
          and(
            eq(vehiclesTable.id, deal.vehicleId),
            eq(vehiclesTable.dealerId, dealerId),
          ),
        );
      if (vehicle) {
        const makeKey = normalizeModelKey(vehicle.make);
        const modelKey = normalizeModelKey(vehicle.model);
        if (makeKey && modelKey) {
          const [mapping] = await db
            .select({ glCode: vehicleModelGlCodesTable.glCode })
            .from(vehicleModelGlCodesTable)
            .where(
              and(
                eq(vehicleModelGlCodesTable.dealerId, dealerId),
                eq(vehicleModelGlCodesTable.makeKey, makeKey),
                eq(vehicleModelGlCodesTable.modelKey, modelKey),
              ),
            );
          if (mapping?.glCode) {
            return {
              account: mapping.glCode,
              source: "model-mapping",
              modelKey: `${makeKey}|${modelKey}`,
            };
          }
        }
      }
    }
  }
  return { account: defaultAccount, source: "dealer-default", modelKey: null };
}

async function handleSalesInvoiceJob(
  job: ErpnextSyncJob,
): Promise<{ docName: string | null }> {
  const conn = await requireConnection(job.dealerId);
  const client = clientFor(conn);
  const action = (job.payload["action"] as string | undefined) ?? "create";

  const [invoice] = await db
    .select()
    .from(invoicesTable)
    .where(
      and(eq(invoicesTable.id, job.entityId), eq(invoicesTable.dealerId, job.dealerId)),
    );
  if (!invoice) throw configError(`Invoice #${job.entityId} no longer exists in AURA`);

  const existing = await getErpnextRef(job.dealerId, "invoice", invoice.id, "Sales Invoice");

  if (action === "cancel") {
    if (!existing) {
      // Never synced — nothing to cancel in ERPNext.
      return { docName: null };
    }
    await client.cancelDoc("Sales Invoice", existing);
    return { docName: existing };
  }

  if (existing) {
    // Already mapped — a prior attempt may have crashed before submit.
    await ensureSubmitted(client, "Sales Invoice", existing);
    return { docName: existing };
  }
  if (invoice.status === "void") return { docName: null }; // voided before it ever synced
  // Zero-value invoices are operational placeholders in AURA, not accounting
  // transactions. ERPNext rejects zero-rate Sales Invoices, so complete the
  // sync job without creating a remote document.
  if (invoice.amount === 0) return { docName: null };
  if (invoice.amount < 0) {
    throw configError(
      `Invoice ${invoice.invoiceNumber} has a negative total; issue it through the refund/credit-note flow instead`,
    );
  }

  const resolved = await resolveInvoiceIncomeAccount(
    job.dealerId,
    invoice,
    conn.incomeAccount,
  );
  if (!resolved.account) {
    throw configError(
      "Set the income account in Settings → ERPNext (accounting mapping) or a vehicle-model GL code before invoices can sync",
    );
  }
  if (!conn.companyName) {
    throw configError(
      "Run the ERPNext connection test in Settings → ERPNext first so AURA learns the ERPNext company",
    );
  }
  const taxLines = invoice.taxLines ?? [];
  if (taxLines.length > 0 && !conn.taxAccount) {
    throw configError(
      "Set the tax account in Settings → ERPNext (accounting mapping) — this invoice carries tax lines",
    );
  }

  // Crash recovery: if a prior attempt created the doc remotely but died
  // before persisting the local ref, adopt it instead of duplicating.
  const remarks = invoiceRemarks(invoice);
  const orphan = await reconcileByRemarks(client, "Sales Invoice", remarks);
  if (orphan) {
    await saveErpnextRef(job.dealerId, "invoice", invoice.id, "Sales Invoice", orphan);
    await ensureSubmitted(client, "Sales Invoice", orphan);
    return { docName: orphan };
  }

  const customer = await resolveInvoiceCustomer(
    job.dealerId,
    invoice.customerId,
    invoice.customerName,
    client,
  );

  const taxTotal =
    Math.round(taxLines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  const base = Math.round((invoice.amount - taxTotal) * 100) / 100;
  const postingDate = invoice.createdAt.toISOString().slice(0, 10);
  const dueDate = normalizeErpnextDueDate(invoice.dueDate, postingDate);

  const itemCode = await ensureSalesItem(client);
  const created = await client.insertDoc("Sales Invoice", {
    customer,
    company: conn.companyName,
    currency: "GYD",
    set_posting_time: 1,
    posting_date: postingDate,
    ...(dueDate ? { due_date: dueDate } : {}),
    remarks,
    items: [
      {
        item_code: itemCode,
        item_name:
          invoice.description?.slice(0, 140) ||
          `${invoice.kind === "reservation" ? "Reservation fee" : "Vehicle sale"} — ${invoice.invoiceNumber}`,
        description: invoice.description ?? invoice.invoiceNumber,
        qty: 1,
        rate: base,
        uom: "Nos",
        income_account: resolved.account,
      },
    ],
    taxes: taxLines.map((tl) => ({
      charge_type: "Actual",
      account_head: conn.taxAccount,
      description: `${tl.name} (${tl.code})`,
      tax_amount: tl.amount,
    })),
  });
  // Persist the mapping BEFORE submit: if we crash after submit, the ref is
  // already in place and the retry just re-verifies via ensureSubmitted.
  await saveErpnextRef(job.dealerId, "invoice", invoice.id, "Sales Invoice", created.name);
  // Snapshot the resolved GL account on the durable job row: later edits to
  // the vehicle-model mapping must never rewrite what this posting used.
  await db
    .update(erpnextSyncJobsTable)
    .set({
      payload: {
        ...job.payload,
        resolvedIncomeAccount: resolved.account,
        incomeAccountSource: resolved.source,
        ...(resolved.modelKey ? { modelKey: resolved.modelKey } : {}),
      },
      updatedAt: new Date(),
    })
    .where(eq(erpnextSyncJobsTable.id, job.id));
  await client.submitDoc("Sales Invoice", created.name);
  return { docName: created.name };
}

// ————————————————————————————————————————————— Payment Entries (one-way) ——

async function handlePaymentEntryJob(
  job: ErpnextSyncJob,
): Promise<{ docName: string | null }> {
  const conn = await requireConnection(job.dealerId);
  const client = clientFor(conn);

  const existing = await getErpnextRef(job.dealerId, "payment", job.entityId, "Payment Entry");
  if (existing) {
    await ensureSubmitted(client, "Payment Entry", existing);
    return { docName: existing };
  }

  const [payment] = await db
    .select()
    .from(paymentsTable)
    .where(
      and(eq(paymentsTable.id, job.entityId), eq(paymentsTable.dealerId, job.dealerId)),
    );
  if (!payment) throw configError(`Payment #${job.entityId} no longer exists in AURA`);
  // Zero payments carry no accounting value and must not wait forever for a
  // zero operational invoice that intentionally has no ERPNext reference.
  if (payment.amount === 0) return { docName: null };

  const [invoice] = await db
    .select()
    .from(invoicesTable)
    .where(
      and(
        eq(invoicesTable.id, payment.invoiceId),
        eq(invoicesTable.dealerId, job.dealerId),
      ),
    );
  if (!invoice) throw configError(`Invoice #${payment.invoiceId} no longer exists in AURA`);

  const invoiceRef = await getErpnextRef(job.dealerId, "invoice", invoice.id, "Sales Invoice");
  if (!invoiceRef) {
    throw waitingFor(
      `Waiting for invoice ${invoice.invoiceNumber} to sync to ERPNext before allocating this payment`,
    );
  }

  // Crash recovery: adopt a doc created by a prior attempt that died before
  // the local ref row was persisted (deterministic remarks key).
  const remarks = paymentRemarks(payment.id, invoice.invoiceNumber);
  const orphan = await reconcileByRemarks(client, "Payment Entry", remarks);
  if (orphan) {
    await saveErpnextRef(job.dealerId, "payment", payment.id, "Payment Entry", orphan);
    await ensureSubmitted(client, "Payment Entry", orphan);
    return { docName: orphan };
  }

  const customer = await resolveInvoiceCustomer(
    job.dealerId,
    invoice.customerId,
    invoice.customerName,
    client,
  );

  if (!conn.companyName) {
    throw configError(
      "Run the ERPNext connection test in Settings → ERPNext first so AURA learns the ERPNext company",
    );
  }
  if (!conn.receivableAccount || !conn.settlementAccount) {
    throw configError(
      "Set the receivable and settlement accounts in Settings → ERPNext (accounting mapping) before payments can sync",
    );
  }

  const isRefund = payment.amount < 0;
  const absAmount = Math.abs(payment.amount);
  const mode = conn.paymentModes?.[payment.method];
  const postingDate = payment.createdAt.toISOString().slice(0, 10);

  const created = await client.insertDoc("Payment Entry", {
    // Refunds flow money back to the customer (Pay); receipts are Receive.
    payment_type: isRefund ? "Pay" : "Receive",
    company: conn.companyName,
    party_type: "Customer",
    party: customer,
    // Ledger legs: receipts move receivable → settlement; refunds reverse.
    paid_from: isRefund ? conn.settlementAccount : conn.receivableAccount,
    paid_to: isRefund ? conn.receivableAccount : conn.settlementAccount,
    posting_date: postingDate,
    paid_amount: absAmount,
    received_amount: absAmount,
    ...(mode ? { mode_of_payment: mode } : {}),
    ...(payment.reference
      ? { reference_no: payment.reference, reference_date: postingDate }
      : {}),
    remarks, // deterministic — doubles as the crash-recovery reconcile key
    references: [
      {
        reference_doctype: "Sales Invoice",
        reference_name: invoiceRef,
        total_amount: invoice.amount,
        // ERPNext allocations are non-negative; payment_type carries the
        // direction (refunds are "Pay").
        allocated_amount: absAmount,
      },
    ],
  });
  // Ref before submit — see Sales Invoice handler for the crash-window rationale.
  await saveErpnextRef(job.dealerId, "payment", payment.id, "Payment Entry", created.name);
  await client.submitDoc("Payment Entry", created.name);
  return { docName: created.name };
}

// ———————————————————————————————————————————————— Customers (inbound) ——

/** Offset (ms) of an IANA timezone at a given instant. */
function tzOffsetMs(instant: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const p: Record<string, number> = {};
  for (const part of dtf.formatToParts(instant)) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(p["year"]!, p["month"]! - 1, p["day"]!, p["hour"]! % 24, p["minute"]!, p["second"]!);
  return asUtc - instant.getTime();
}

/** ERPNext `modified` is a NAIVE site-local timestamp
 * ("YYYY-MM-DD HH:mm:ss[.ffffff]"). Interpret it in the connection's stored
 * site timezone (captured from System Settings during the connection test);
 * fall back to UTC when the timezone is unknown or invalid. Exported for the
 * entity-sync verification script. */
export function parseErpnextModified(value: unknown, siteTimezone?: string | null): Date | null {
  if (typeof value !== "string" || !value) return null;
  const naiveAsUtc = new Date(`${value.replace(" ", "T")}Z`);
  if (Number.isNaN(naiveAsUtc.getTime())) return null;
  if (!siteTimezone) return naiveAsUtc;
  try {
    // Two-pass: the offset near the instant is stable except exactly at DST
    // transitions, where ordering precision of ±1h is acceptable.
    const approx = new Date(naiveAsUtc.getTime() - tzOffsetMs(naiveAsUtc, siteTimezone));
    return new Date(naiveAsUtc.getTime() - tzOffsetMs(approx, siteTimezone));
  } catch {
    return naiveAsUtc; // unknown IANA name → UTC fallback
  }
}

async function handleInboundCustomer(event: {
  dealerId: number;
  doctype: string;
  docName: string | null;
  event: string | null;
  payload: Record<string, unknown>;
}): Promise<void> {
  const { dealerId, docName, payload } = event;
  if (!docName) throw new Error("Customer webhook payload is missing the doc name");

  const [ref] = await db
    .select()
    .from(erpnextRefsTable)
    .where(
      and(
        eq(erpnextRefsTable.dealerId, dealerId),
        eq(erpnextRefsTable.doctype, "Customer"),
        eq(erpnextRefsTable.docName, docName),
        eq(erpnextRefsTable.entityType, "customer"),
      ),
    );
  if (!ref) {
    // An ERPNext webhook can race the outbound Customer job before its ref is
    // persisted. External/unmapped ERPNext customers are not imported into
    // AURA, so treating this as a no-op is both safe and retry-free.
    return;
  }

  const [customer] = await db
    .select()
    .from(customersTable)
    .where(
      and(eq(customersTable.id, ref.entityId), eq(customersTable.dealerId, dealerId)),
    );
  if (!customer) throw new Error(`Mapped AURA customer #${ref.entityId} no longer exists`);
  if (customer.erasedAt || customer.deletedAt) return; // never resurrect erased/deleted records

  // Contact fields ERPNext is allowed to write back.
  const incoming: Partial<Record<"name" | "email" | "phone" | "taxNumber", string | null>> = {};
  if (typeof payload["customer_name"] === "string" && payload["customer_name"].trim()) {
    incoming.name = payload["customer_name"].trim();
  }
  if ("email_id" in payload) {
    incoming.email = typeof payload["email_id"] === "string" && payload["email_id"] ? payload["email_id"] : null;
  }
  if ("mobile_no" in payload) {
    incoming.phone = typeof payload["mobile_no"] === "string" && payload["mobile_no"] ? payload["mobile_no"] : null;
  }
  if ("tax_id" in payload) {
    incoming.taxNumber = typeof payload["tax_id"] === "string" && payload["tax_id"] ? payload["tax_id"] : null;
  }

  const changed = (Object.entries(incoming) as [keyof typeof incoming, string | null][])
    .filter(([k, v]) => (customer[k] ?? null) !== (v ?? null));

  // Last-write-wins: if AURA edited this record after the ERPNext doc's
  // modified timestamp, keep AURA's values and log the conflict. ERPNext
  // sends naive site-local timestamps — order them in the site timezone.
  const conn = await getErpnextConnection(dealerId);
  const erpModified = parseErpnextModified(payload["modified"], conn?.siteTimezone);
  const auraNewer =
    erpModified != null && customer.updatedAt != null && customer.updatedAt > erpModified;

  let outcome: string;
  if (changed.length === 0) {
    outcome = "No contact-field changes to apply";
  } else if (auraNewer) {
    outcome = `Conflict: AURA edited this customer more recently (${customer.updatedAt.toISOString()}) than ERPNext (${erpModified.toISOString()}) — kept AURA values for ${changed.map(([k]) => k).join(", ")}`;
  } else {
    await db
      .update(customersTable)
      .set({ ...Object.fromEntries(changed), updatedAt: new Date() })
      .where(
        and(eq(customersTable.id, customer.id), eq(customersTable.dealerId, dealerId)),
      );
    outcome = `Applied ${changed.map(([k]) => k).join(", ")} from ERPNext`;
  }

  // Surface what happened in the sync activity log (inbound entry).
  await db.insert(erpnextSyncJobsTable).values({
    dealerId,
    direction: "inbound",
    doctype: "Customer",
    operation: "update",
    entityType: "customer",
    entityId: customer.id,
    payload: { docName, applied: changed.map(([k]) => k), outcome },
    status: "succeeded",
    attempts: 1,
    lastError: auraNewer && changed.length > 0 ? outcome : null,
    erpnextDocName: docName,
    completedAt: new Date(),
  });
}

// ——————————————————————————————————————————————————— Enqueue helpers ——

/** Fire-safe enqueue (used from request paths): log, never throw. */
function fireSafe(p: Promise<unknown>, what: string): void {
  void p.catch((err) => logger.error({ err }, `ERPNext enqueue failed: ${what}`));
}

export function queueCustomerSync(
  dealerId: number,
  customerId: number,
  opts: { dedupeKey?: string } = {},
): void {
  fireSafe(
    enqueueErpnextSync({
      dealerId,
      doctype: "Customer",
      entityType: "customer",
      entityId: customerId,
      operation: "update",
      ...(opts.dedupeKey ? { dedupeKey: opts.dedupeKey } : {}),
    }),
    `customer #${customerId}`,
  );
}

export function queueInvoiceSync(
  dealerId: number,
  invoiceId: number,
  action: "create" | "cancel",
  opts: { dedupeKey?: string } = {},
): void {
  fireSafe(
    enqueueErpnextSync({
      dealerId,
      doctype: "Sales Invoice",
      entityType: "invoice",
      entityId: invoiceId,
      operation: action === "cancel" ? "update" : "insert",
      payload: { action },
      dedupeKey: opts.dedupeKey ?? `invoice:${dealerId}:${invoiceId}:${action}`,
    }),
    `invoice #${invoiceId} ${action}`,
  );
}

export function queuePaymentSync(
  dealerId: number,
  paymentId: number,
  opts: { dedupeKey?: string } = {},
): void {
  fireSafe(
    enqueueErpnextSync({
      dealerId,
      doctype: "Payment Entry",
      entityType: "payment",
      entityId: paymentId,
      operation: "insert",
      dedupeKey: opts.dedupeKey ?? `payment:${dealerId}:${paymentId}`,
    }),
    `payment #${paymentId}`,
  );
}

// —————————————————————————————————————————————————————————— Backfill ——

/** Per-dealer backfill: enqueue every existing customer, issued invoice and
 * payment. Dedupe keys make the action safely re-runnable; customer matching
 * by email/phone happens in the outbound handler to avoid duplicates. */
export async function backfillErpnext(dealerId: number): Promise<{
  customers: number;
  invoices: number;
  payments: number;
}> {
  const customers = await db
    .select({ id: customersTable.id })
    .from(customersTable)
    .where(eq(customersTable.dealerId, dealerId));
  const invoices = await db
    .select({ id: invoicesTable.id, status: invoicesTable.status })
    .from(invoicesTable)
    .where(eq(invoicesTable.dealerId, dealerId));
  const payments = await db
    .select({ id: paymentsTable.id })
    .from(paymentsTable)
    .where(eq(paymentsTable.dealerId, dealerId));

  let c = 0;
  for (const row of customers) {
    const id = await enqueueErpnextSync({
      dealerId,
      doctype: "Customer",
      entityType: "customer",
      entityId: row.id,
      operation: "update",
      dedupeKey: `backfill:customer:${dealerId}:${row.id}`,
    });
    if (id != null) c++;
  }
  let i = 0;
  for (const row of invoices) {
    if (row.status === "void") continue; // nothing to post
    const id = await enqueueErpnextSync({
      dealerId,
      doctype: "Sales Invoice",
      entityType: "invoice",
      entityId: row.id,
      operation: "insert",
      payload: { action: "create" },
      dedupeKey: `invoice:${dealerId}:${row.id}:create`,
    });
    if (id != null) i++;
  }
  let p = 0;
  for (const row of payments) {
    const id = await enqueueErpnextSync({
      dealerId,
      doctype: "Payment Entry",
      entityType: "payment",
      entityId: row.id,
      operation: "insert",
      dedupeKey: `payment:${dealerId}:${row.id}`,
    });
    if (id != null) p++;
  }
  return { customers: c, invoices: i, payments: p };
}

// ————————————————————————————————————————————————————— Registration ——

let registered = false;

export function registerErpnextEntitySync(): void {
  if (registered) return;
  registered = true;
  registerErpnextSyncHandler("Customer", handleCustomerJob);
  registerErpnextSyncHandler("Sales Invoice", handleSalesInvoiceJob);
  registerErpnextSyncHandler("Payment Entry", handlePaymentEntryJob);
  registerErpnextInboundHandler("Customer", handleInboundCustomer);
  logger.info("ERPNext entity sync handlers registered (Customer, Sales Invoice, Payment Entry)");
}
