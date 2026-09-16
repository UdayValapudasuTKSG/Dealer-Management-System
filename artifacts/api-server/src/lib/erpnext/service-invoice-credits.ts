import { and, eq } from "drizzle-orm";
import {
  db,
  customersTable,
  partCreditNotesTable,
  serviceInvoicesTable,
  type ErpnextConnection,
  type ErpnextSyncJob,
} from "@workspace/db";
import { ErpnextError, type ErpnextClient } from "./client";
import { clientFor, getErpnextConnection } from "./connection";
import {
  enqueueErpnextSync,
  getErpnextRef,
  saveErpnextRef,
} from "./sync";
import { logger } from "../logger";

/**
 * A service part return is two distinct ERPNext documents:
 *
 * - parts-sync posts its Material Receipt, which restores physical stock;
 * - this queue posts a submitted, non-stock Sales Invoice return, which
 *   reduces the customer's receivable without ever rewriting the issued
 *   invoice.
 *
 * The original service invoice must already be represented by an explicit
 * external reference (`service_invoice` → `Sales Invoice`).  We deliberately
 * do not guess a document from a customer or an invoice number: applying a
 * credit to the wrong receivable is worse than leaving this durable job
 * visibly waiting for the original invoice to be mapped.
 */

type CreditPayload = {
  serviceInvoiceId?: number;
  creditNoteId?: number;
  netAmount?: number;
  taxAmount?: number;
  grossAmount?: number;
};

export type ServiceInvoiceErpLine = {
  description: string;
  amount: number;
};

type OriginalServiceInvoicePayload = {
  serviceInvoiceId?: number;
  customerId?: number | null;
  customerName?: string;
  vehicleInfo?: string;
  originalTotal?: number;
  tax?: number;
  issuedAt?: string;
  lines?: ServiceInvoiceErpLine[];
};

type SalesInvoiceDoc = {
  docstatus?: number;
  customer?: string;
  company?: string;
  currency?: string;
  items?: Array<{
    item_code?: string;
    item_name?: string;
    description?: string;
    uom?: string;
    income_account?: string;
  }>;
};

function waitingFor(message: string): ErpnextError {
  return new ErpnextError(message, 0, "network");
}

function configError(message: string): ErpnextError {
  return new ErpnextError(message, 422, "http");
}

function asMoney(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw configError(`Malformed service invoice credit payload: ${field} must be a positive amount`);
  }
  return Math.round(value * 100) / 100;
}

function creditRemarks(creditNoteId: number, serviceInvoiceId: number): string {
  return `AURA service part credit #${creditNoteId} · service invoice #${serviceInvoiceId}`;
}

function serviceInvoiceRemarks(serviceInvoiceId: number): string {
  return `AURA service invoice #${serviceInvoiceId}`;
}

async function reconcileByRemarks(
  client: ErpnextClient,
  remarks: string,
): Promise<string | null> {
  const rows = await client.listDocs<{ name: string }>("Sales Invoice", {
    filters: [["Sales Invoice", "remarks", "=", remarks]],
    fields: ["name"],
    limit: 1,
  });
  return rows[0]?.name ?? null;
}

async function ensureSubmittedCredit(
  client: ErpnextClient,
  name: string,
): Promise<void> {
  const doc = await client.getDoc<{ docstatus?: number }>("Sales Invoice", name);
  if ((doc.docstatus ?? 0) === 0) {
    await client.submitDoc("Sales Invoice", name);
    return;
  }
  if (doc.docstatus !== 1) {
    throw configError(
      `ERPNext service credit ${name} was cancelled; review it before retrying the AURA credit`,
    );
  }
}

async function ensureSubmitted(
  client: ErpnextClient,
  name: string,
): Promise<void> {
  const doc = await client.getDoc<{ docstatus?: number }>("Sales Invoice", name);
  if ((doc.docstatus ?? 0) === 0) await client.submitDoc("Sales Invoice", name);
  else if (doc.docstatus !== 1) {
    throw configError(
      `ERPNext service invoice ${name} was cancelled; review it before retrying AURA's posting`,
    );
  }
}

/** Resolve the customer using the immutable invoice recipient snapshot. This
 * intentionally does not borrow the vehicle-invoice helper: service invoices
 * have their own AURA entity/ref namespace. */
async function resolveServiceInvoiceCustomer(
  dealerId: number,
  customerId: number | null,
  customerName: string,
  client: ErpnextClient,
): Promise<string> {
  if (customerId != null) {
    const mapped = await getErpnextRef(dealerId, "customer", customerId, "Customer");
    if (mapped) return mapped;
  }
  const matches = await client.listDocs<{ name: string }>("Customer", {
    filters: [["Customer", "customer_name", "=", customerName]],
    fields: ["name"],
    limit: 1,
  });
  const docName =
    matches[0]?.name ??
    (
      await client.insertDoc("Customer", {
        customer_name: customerName,
        customer_type: "Individual",
      })
    ).name;
  // A later normal customer sync may enrich contact details, but both service
  // and vehicle financial documents now resolve the same customer mapping.
  if (customerId != null) {
    const [customer] = await db
      .select({ id: customersTable.id })
      .from(customersTable)
      .where(
        and(
          eq(customersTable.id, customerId),
          eq(customersTable.dealerId, dealerId),
        ),
      );
    if (customer) {
      await saveErpnextRef(dealerId, "customer", customer.id, "Customer", docName);
    }
  }
  return docName;
}

async function ensureServiceItem(client: ErpnextClient): Promise<string> {
  const itemCode = "AURA-SERVICE";
  try {
    await client.getDoc("Item", itemCode);
    return itemCode;
  } catch (error) {
    if (!(error instanceof ErpnextError) || error.kind !== "not_found") throw error;
  }
  await client.insertDoc("Item", {
    item_code: itemCode,
    item_name: "AURA workshop service",
    item_group: "All Item Groups",
    stock_uom: "Nos",
    is_stock_item: 0,
    is_sales_item: 1,
  });
  return itemCode;
}

function validateOriginalSnapshot(payload: OriginalServiceInvoicePayload): {
  serviceInvoiceId: number;
  customerId: number | null;
  customerName: string;
  vehicleInfo: string;
  originalTotal: number;
  tax: number;
  postingDate: string;
  lines: ServiceInvoiceErpLine[];
} {
  if (!Number.isInteger(payload.serviceInvoiceId)) {
    throw configError("Malformed service invoice sync payload: invalid serviceInvoiceId");
  }
  const serviceInvoiceId = payload.serviceInvoiceId as number;
  const customerName = payload.customerName?.trim();
  const vehicleInfo = payload.vehicleInfo?.trim();
  if (!customerName || !vehicleInfo) {
    throw configError(
      "Malformed service invoice sync payload: customerName and vehicleInfo are required",
    );
  }
  const originalTotal = asMoney(payload.originalTotal, "originalTotal");
  const tax =
    typeof payload.tax === "number" && Number.isFinite(payload.tax) && payload.tax >= 0
      ? Math.round(payload.tax * 100) / 100
      : (() => {
          throw configError("Malformed service invoice sync payload: tax must be zero or positive");
        })();
  const issued = payload.issuedAt ? new Date(payload.issuedAt) : null;
  if (!issued || Number.isNaN(issued.getTime())) {
    throw configError("Malformed service invoice sync payload: issuedAt is invalid");
  }
  const lines = (payload.lines ?? [])
    .map((line) => ({
      description: line.description?.trim() ?? "",
      amount: Math.round(line.amount * 100) / 100,
    }))
    .filter((line) => line.amount !== 0);
  if (
    lines.length === 0 ||
    lines.some(
      (line) =>
        !line.description ||
        !Number.isFinite(line.amount) ||
        line.amount < 0,
    )
  ) {
    throw configError(
      "Malformed service invoice sync payload: at least one non-negative described line is required",
    );
  }
  const net = Math.round(lines.reduce((sum, line) => sum + line.amount, 0) * 100) / 100;
  if (Math.abs(originalTotal - (net + tax)) > 0.01) {
    throw configError(
      "Malformed service invoice sync payload: originalTotal must equal the immutable line total plus tax",
    );
  }
  return {
    serviceInvoiceId,
    customerId: payload.customerId ?? null,
    customerName,
    vehicleInfo,
    originalTotal,
    tax,
    postingDate: issued.toISOString().slice(0, 10),
    lines,
  };
}

/**
 * Queue the original submitted ERPNext Sales Invoice for a service invoice.
 * The caller must snapshot the issued document's original total, tax and
 * charge lines in this payload; the job never rebuilds those values from a
 * mutable job card or from later credit/discount adjustments.
 */
export function queueServiceInvoiceSync(input: {
  dealerId: number;
  serviceInvoiceId: number;
  customerId: number | null;
  customerName: string;
  vehicleInfo: string;
  originalTotal: number;
  tax: number;
  issuedAt: Date | string;
  lines: ServiceInvoiceErpLine[];
}): void {
  const issuedAt =
    input.issuedAt instanceof Date ? input.issuedAt.toISOString() : input.issuedAt;
  void enqueueErpnextSync({
    dealerId: input.dealerId,
    doctype: "Sales Invoice",
    entityType: "service_invoice",
    entityId: input.serviceInvoiceId,
    operation: "insert",
    payload: {
      serviceInvoiceId: input.serviceInvoiceId,
      customerId: input.customerId,
      customerName: input.customerName,
      vehicleInfo: input.vehicleInfo,
      originalTotal: input.originalTotal,
      tax: input.tax,
      issuedAt,
      lines: input.lines,
    },
    dedupeKey: `service-invoice:${input.dealerId}:${input.serviceInvoiceId}:issue`,
  }).catch((err) =>
    logger.error(
      { err, ...input, issuedAt },
      "ERPNext enqueue failed: original service invoice",
    ),
  );
}

/** Handler for queue jobs whose entityType is `service_invoice`. */
export async function handleServiceInvoiceJob(
  job: ErpnextSyncJob,
): Promise<{ docName: string | null }> {
  const snapshot = validateOriginalSnapshot(job.payload as OriginalServiceInvoicePayload);
  if (snapshot.serviceInvoiceId !== job.entityId) {
    throw configError("Malformed service invoice sync payload: entity id does not match");
  }
  const [invoice] = await db
    .select({ id: serviceInvoicesTable.id, status: serviceInvoicesTable.status })
    .from(serviceInvoicesTable)
    .where(
      and(
        eq(serviceInvoicesTable.id, snapshot.serviceInvoiceId),
        eq(serviceInvoicesTable.dealerId, job.dealerId),
      ),
    );
  if (!invoice) {
    throw configError(`Service invoice #${snapshot.serviceInvoiceId} no longer exists in AURA`);
  }
  // Do not post a document that was voided before its asynchronous accounting
  // job got a chance to run. An already-mapped submitted original is immutable
  // and intentionally not altered by this handler.
  if (invoice.status === "void") return { docName: null };

  const conn = await getErpnextConnection(job.dealerId);
  if (!conn?.enabled) {
    throw waitingFor("ERPNext is not connected for this dealership");
  }
  if (!conn.companyName || !conn.incomeAccount) {
    throw configError(
      "Set the company and income account in Settings → ERPNext before service invoices can sync",
    );
  }
  if (snapshot.tax > 0 && !conn.taxAccount) {
    throw configError(
      "Set the tax account in Settings → ERPNext before tax-bearing service invoices can sync",
    );
  }
  const client = clientFor(conn);
  const existing = await getErpnextRef(
    job.dealerId,
    "service_invoice",
    snapshot.serviceInvoiceId,
    "Sales Invoice",
  );
  if (existing) {
    await ensureSubmitted(client, existing);
    return { docName: existing };
  }
  const remarks = serviceInvoiceRemarks(snapshot.serviceInvoiceId);
  const orphan = await reconcileByRemarks(client, remarks);
  if (orphan) {
    await saveErpnextRef(
      job.dealerId,
      "service_invoice",
      snapshot.serviceInvoiceId,
      "Sales Invoice",
      orphan,
    );
    await ensureSubmitted(client, orphan);
    return { docName: orphan };
  }
  const customer = await resolveServiceInvoiceCustomer(
    job.dealerId,
    snapshot.customerId,
    snapshot.customerName,
    client,
  );
  const itemCode = await ensureServiceItem(client);
  const created = await client.insertDoc("Sales Invoice", {
    customer,
    company: conn.companyName,
    currency: "GYD",
    set_posting_time: 1,
    posting_date: snapshot.postingDate,
    update_stock: 0,
    remarks,
    items: snapshot.lines.map((line) => ({
      item_code: itemCode,
      item_name: line.description.slice(0, 140),
      description: `${snapshot.vehicleInfo} — ${line.description}`,
      qty: 1,
      rate: line.amount,
      uom: "Nos",
      income_account: conn.incomeAccount,
    })),
    ...(snapshot.tax > 0
      ? {
          taxes: [
            {
              charge_type: "Actual",
              account_head: conn.taxAccount,
              description: "AURA service invoice tax",
              tax_amount: snapshot.tax,
            },
          ],
        }
      : {}),
  });
  await saveErpnextRef(
    job.dealerId,
    "service_invoice",
    snapshot.serviceInvoiceId,
    "Sales Invoice",
    created.name,
  );
  await ensureSubmitted(client, created.name);
  return { docName: created.name };
}

/**
 * Queue a non-stock ERPNext credit note after the local credit/adjustment
 * transaction commits. Amounts are immutable job-payload facts, not derived
 * later from mutable invoice totals. `netAmount` is the returned part value;
 * `taxAmount` is the proportional tax reversal; their sum is the receivable
 * reduction. No Payment Entry/cash refund is created.
 */
export function queueServiceInvoiceCreditSync(input: {
  dealerId: number;
  serviceInvoiceId: number;
  creditNoteId: number;
  netAmount: number;
  taxAmount: number;
  grossAmount: number;
}): void {
  void enqueueErpnextSync({
    dealerId: input.dealerId,
    doctype: "Sales Invoice",
    entityType: "service_invoice_credit",
    entityId: input.creditNoteId,
    operation: "insert",
    payload: {
      serviceInvoiceId: input.serviceInvoiceId,
      creditNoteId: input.creditNoteId,
      netAmount: input.netAmount,
      taxAmount: input.taxAmount,
      grossAmount: input.grossAmount,
    },
    // A part-credit row is inserted exactly once; retrying enqueue and the
    // worker's crash recovery can therefore never create two credit invoices.
    dedupeKey: `service-invoice-credit:${input.dealerId}:${input.creditNoteId}`,
  }).catch((err) =>
    logger.error(
      { err, ...input },
      "ERPNext enqueue failed: service invoice part credit",
    ),
  );
}

/** Handler for queue jobs whose entityType is `service_invoice_credit`. */
export async function handleServiceInvoiceCreditJob(
  job: ErpnextSyncJob,
): Promise<{ docName: string | null }> {
  const payload = job.payload as CreditPayload;
  const serviceInvoiceId = payload.serviceInvoiceId;
  const creditNoteId = payload.creditNoteId ?? job.entityId;
  if (
    !Number.isInteger(serviceInvoiceId) ||
    !Number.isInteger(creditNoteId) ||
    creditNoteId !== job.entityId
  ) {
    throw configError("Malformed service invoice credit payload: invalid identifiers");
  }
  const resolvedServiceInvoiceId = serviceInvoiceId as number;
  const netAmount = asMoney(payload.netAmount, "netAmount");
  const taxAmount =
    typeof payload.taxAmount === "number" &&
    Number.isFinite(payload.taxAmount) &&
    payload.taxAmount >= 0
      ? Math.round(payload.taxAmount * 100) / 100
      : (() => {
          throw configError(
            "Malformed service invoice credit payload: taxAmount must be zero or positive",
          );
        })();
  const grossAmount = asMoney(payload.grossAmount, "grossAmount");
  if (Math.abs(grossAmount - (netAmount + taxAmount)) > 0.01) {
    throw configError(
      "Malformed service invoice credit payload: grossAmount must equal netAmount plus taxAmount",
    );
  }

  const [credit] = await db
    .select()
    .from(partCreditNotesTable)
    .where(
      and(
        eq(partCreditNotesTable.id, creditNoteId),
        eq(partCreditNotesTable.dealerId, job.dealerId),
      ),
    );
  if (!credit) {
    throw configError(`Part credit #${creditNoteId} no longer exists in AURA`);
  }
  if (Math.abs(credit.amount - netAmount) > 0.01) {
    throw configError(
      `Part credit #${creditNoteId} amount no longer matches its durable ERPNext credit job`,
    );
  }
  const [invoice] = await db
    .select({
      id: serviceInvoicesTable.id,
      jobCardId: serviceInvoicesTable.jobCardId,
      status: serviceInvoicesTable.status,
    })
    .from(serviceInvoicesTable)
    .where(
      and(
        eq(serviceInvoicesTable.id, resolvedServiceInvoiceId),
        eq(serviceInvoicesTable.dealerId, job.dealerId),
      ),
    );
  if (!invoice || invoice.jobCardId !== credit.jobCardId) {
    throw configError(
      `Service invoice #${resolvedServiceInvoiceId} does not belong to part credit #${creditNoteId}`,
    );
  }
  if (invoice.status === "void") {
    throw configError(`Service invoice #${resolvedServiceInvoiceId} is void and cannot receive a credit`);
  }

  const conn = await getErpnextConnection(job.dealerId);
  if (!conn?.enabled) {
    throw waitingFor("ERPNext is not connected for this dealership");
  }
  const client = clientFor(conn);
  const existing = await getErpnextRef(
    job.dealerId,
    "service_invoice_credit",
    creditNoteId,
    "Sales Invoice",
  );
  if (existing) {
    await ensureSubmittedCredit(client, existing);
    return { docName: existing };
  }

  const originalName = await getErpnextRef(
    job.dealerId,
    "service_invoice",
    resolvedServiceInvoiceId,
    "Sales Invoice",
  );
  if (!originalName) {
    throw waitingFor(
      `Waiting for the mapped ERPNext Sales Invoice for AURA service invoice #${resolvedServiceInvoiceId}; service part credit #${creditNoteId} has not been posted`,
    );
  }
  const original = await client.getDoc<SalesInvoiceDoc>("Sales Invoice", originalName);
  if (original.docstatus !== 1) {
    throw waitingFor(
      `Waiting for ERPNext service invoice ${originalName} to be submitted before posting part credit #${creditNoteId}`,
    );
  }
  const originalLine = original.items?.find((item) => item.item_code);
  if (!original.customer || !original.company || !originalLine?.item_code) {
    throw configError(
      `Mapped ERPNext service invoice ${originalName} is missing its customer, company, or billable item`,
    );
  }
  if (taxAmount > 0 && !conn.taxAccount) {
    throw configError(
      "Set the tax account in Settings → ERPNext before tax-bearing service credits can sync",
    );
  }

  const remarks = creditRemarks(creditNoteId, resolvedServiceInvoiceId);
  const orphan = await reconcileByRemarks(client, remarks);
  if (orphan) {
    await saveErpnextRef(
      job.dealerId,
      "service_invoice_credit",
      creditNoteId,
      "Sales Invoice",
      orphan,
    );
    await ensureSubmittedCredit(client, orphan);
    return { docName: orphan };
  }

  const postingDate = credit.createdAt.toISOString().slice(0, 10);
  const created = await client.insertDoc("Sales Invoice", {
    customer: original.customer,
    company: original.company,
    currency: original.currency || "GYD",
    set_posting_time: 1,
    posting_date: postingDate,
    is_return: 1,
    return_against: originalName,
    // Stock was restored by the separate Material Receipt. Setting this false
    // avoids ERPNext double-restoring inventory from the financial return.
    update_stock: 0,
    remarks,
    items: [
      {
        item_code: originalLine.item_code,
        item_name: originalLine.item_name,
        description: `AURA part credit: ${credit.partName} — ${credit.reason}`,
        qty: -credit.quantity,
        rate: Math.round((netAmount / credit.quantity) * 100) / 100,
        uom: originalLine.uom || "Nos",
        ...(originalLine.income_account
          ? { income_account: originalLine.income_account }
          : {}),
      },
    ],
    ...(taxAmount > 0
      ? {
          taxes: [
            {
              charge_type: "Actual",
              account_head: conn.taxAccount,
              description: `AURA tax reversal for service part credit #${creditNoteId}`,
              tax_amount: -taxAmount,
            },
          ],
        }
      : {}),
  });
  // Save before submit to close the remote-create/local-ref crash window.
  await saveErpnextRef(
    job.dealerId,
    "service_invoice_credit",
    creditNoteId,
    "Sales Invoice",
    created.name,
  );
  await ensureSubmittedCredit(client, created.name);
  return { docName: created.name };
}
