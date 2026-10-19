import { and, eq, sql } from "drizzle-orm";
import { db, partsPosSettingsTable as settings, partsPosRequestsTable as requests,
  partsTable, inventoryLevelsTable, type ErpnextSyncJob } from "@workspace/db";
import { clientFor, getErpnextConnection } from "./connection";
import { ErpnextClient } from "./client";
import { registerErpnextSyncHandler, getErpnextRef } from "./sync";
import { resolveAccount } from "./account-resolution";
import { posLock, type PosTx, type PosRequest, source } from "../parts-pos";
import { posConfigSchema, posInputSchema, money, type PosConfig, type PosSnapshot } from "../parts-pos-policy";
import { ensureInventory, moveStock } from "../parts-inventory";

async function connection(dealerId: number) {
  const conn = await getErpnextConnection(dealerId);
  if (!conn?.enabled || !conn.companyName) throw new Error("Configure and test this dealer's ERPNext connection first");
  const client = clientFor(conn);
  const company = await client.getDoc<{ default_currency: string }>("Company", conn.companyName);
  if (company.default_currency !== "GYD") throw new Error("The POS company currency must be GYD");
  return { client, company: conn.companyName };
}
async function validateConfig(dealerId: number, config: PosConfig) {
  const { client, company } = await connection(dealerId);
  if (!config.taxApproved || !config.approvalReference) throw new Error("Finance must approve the parts tax treatment");
  if (!config.sources.length || !config.items.length) throw new Error("Configure payment sources and at least one stock item");
  const accounts: { label: string; value: string; root: string; type?: string }[] = [
    { label: "Receivable", value: config.receivable, root: "Asset", type: "Receivable" },
    { label: "VAT", value: config.vat, root: "Liability" },
    { label: "Over/short", value: config.overShort, root: "Expense" },
    { label: "Opening offset", value: config.openingOffset, root: "Equity" },
    ...config.sources.map(s => ({ label: s.label, value: s.account, root: "Asset", type: s.kind === "cash" ? "Cash" : "Bank" })),
    ...config.brands.flatMap(b => [
      { label: `${b.brand} income`, value: b.income, root: "Income" },
      { label: `${b.brand} COGS`, value: b.cogs, root: "Expense" },
      { label: `${b.brand} inventory`, value: b.inventory, root: "Asset", type: "Stock" },
    ]),
  ];
  for (const a of accounts) {
    try {
      const doc = await resolveAccount(client, company, a.value);
      if (doc.name !== a.value) throw new Error(`Use full ERPNext name: ${doc.name}`);
      if (doc.is_group || doc.disabled || doc.root_type !== a.root || (a.type && doc.account_type !== a.type) ||
        (doc.account_currency && doc.account_currency !== "GYD")) throw new Error("Account type, currency or status is invalid");
    } catch (e) { throw new Error(`${a.label}: ${e instanceof Error ? e.message : "account validation failed"}`); }
  }
  const center = await client.getDoc<{ company: string; is_group: number; disabled: number }>("Cost Center", config.costCenter);
  if (center.company !== company || center.is_group || center.disabled) throw new Error("Select an active leaf cost center in this company");
  for (const b of config.brands) {
    const wh = await client.getDoc<{ company: string; account: string; is_group: number; disabled: number }>("Warehouse", b.warehouse);
    if (wh.company !== company || wh.is_group || wh.disabled || wh.account !== b.inventory)
      throw new Error(`${b.brand}: warehouse must explicitly use the configured inventory account in this company`);
  }
  for (const mapping of config.items) {
    const [part] = await db.select({ id: partsTable.id }).from(partsTable).where(and(eq(partsTable.id, mapping.partId), eq(partsTable.dealerId, dealerId)));
    if (!part) throw new Error("An item mapping references another dealer or a missing part");
    const item = await client.getDoc<{ is_stock_item: number; disabled: number; has_serial_no: number; has_batch_no: number; valuation_method: string }>("Item", mapping.itemCode);
    if (!item.is_stock_item || item.disabled || item.has_serial_no || item.has_batch_no || item.valuation_method !== "Moving Average")
      throw new Error(`${mapping.itemCode}: use an active, non-serial, non-batch stock Item with Moving Average valuation`);
  }
  return { client, company };
}

/** Exact, company-scoped marker recovery also covers a crash after remote insert
 * but before any local commit. Never cancel/recreate submitted accounting docs. */
async function document(client: ErpnextClient, company: string, doctype: string, marker: string,
  data: Record<string, unknown>, expectedTotal?: number) {
  const markerField = doctype === "Journal Entry" ? "user_remark" : "remarks";
  const found = await client.listDocs<{ name: string }>(doctype, {
    filters: [[doctype, "company", "=", company], [doctype, markerField, "=", marker], [doctype, "docstatus", "!=", 2]],
    fields: ["name"], limit: 2,
  });
  if (found.length > 1) throw new Error("Duplicate ERP document markers; Finance reconciliation required");
  const name = found[0]?.name ?? (await client.insertDoc(doctype, { ...data, company, [markerField]: marker, docstatus: 0 })).name;
  const doc = await client.getDoc<{ docstatus: number; grand_total?: number; currency?: string;
    accounts?: Record<string, unknown>[]; items?: Record<string, unknown>[]; customer?: string;
    debit_to?: string; update_stock?: number; taxes?: Record<string, unknown>[] }>(doctype, name);
  if (doctype === "Journal Entry") {
    const expected = data.accounts as Record<string, unknown>[];
    const actual = doc.accounts ?? [];
    const same = actual.length === expected.length && expected.every((line,i) => {
      const got = actual[i];
      return ["account", "party", "party_type", "reference_type", "reference_name"].every(k => (line[k] ?? "") === (got[k] ?? ""))
        && ["debit_in_account_currency", "credit_in_account_currency"].every(k => Math.abs(Number(line[k] ?? 0) - Number(got[k] ?? 0)) < 0.005);
    });
    if (!same) throw new Error(`ERP journal ${name} differs from the Finance-approved posting; manual reconciliation required`);
  } else if (doctype === "Sales Invoice") {
    const expected = data.items as Record<string, unknown>[];
    const actual = doc.items ?? [];
    const same = actual.length === expected.length && expected.every((line,i) => {
      const got = actual[i];
      return ["item_code", "income_account", "expense_account", "warehouse"].every(k => line[k] === got[k])
        && ["qty", "rate"].every(k => Math.abs(Number(line[k]) - Number(got[k])) < 0.00001);
    });
    const expectedTax = data.taxes as Record<string, unknown>[];
    if (!same || doc.customer !== data.customer || doc.debit_to !== data.debit_to || doc.update_stock !== 1 ||
      (doc.taxes ?? []).length !== expectedTax.length || !expectedTax.every((tax,i) =>
        tax.account_head === doc.taxes?.[i]?.account_head && Math.abs(Number(tax.tax_amount) - Number(doc.taxes?.[i]?.tax_amount)) < 0.005))
      throw new Error(`ERP invoice ${name} differs from approved items, stock or tax mappings; manual reconciliation required`);
  }
  if (expectedTotal !== undefined && (doc.currency !== "GYD" || Math.abs(Number(doc.grand_total) - expectedTotal) > 0.01))
    throw new Error(`ERP document ${name} has a different total/currency; check item tax templates and pricing rules before retrying`);
  if (doc.docstatus === 0) await client.submitDoc(doctype, name);
  else if (doc.docstatus !== 1) throw new Error("ERP document was cancelled; reconcile before retrying");
  return { doctype, name };
}
async function customer(client: ErpnextClient, dealerId: number, r: PosRequest, snapshot: PosSnapshot) {
  if (snapshot.erpCustomer) return snapshot.erpCustomer;
  const input = posInputSchema.parse(r.input);
  if (input.customerId) {
    const ref = await getErpnextRef(dealerId, "customer", input.customerId, "Customer");
    if (!ref) throw new Error("Sync this registered customer to ERPNext first");
    const c = await client.getDoc<{ disabled: number }>("Customer", ref);
    if (c.disabled) throw new Error("ERP customer is disabled");
    return ref;
  }
  const name = `AURA POS Walk-in — dealer ${dealerId}`;
  const found = await client.listDocs<{ name: string }>("Customer", { filters: [["customer_name", "=", name]], fields: ["name"], limit: 2 });
  if (found.length > 1) throw new Error("Duplicate walk-in customer; resolve in ERPNext");
  return found[0]?.name ?? (await client.insertDoc("Customer", { customer_name: name, customer_type: "Individual" })).name;
}
async function stockPreflight(tx: PosTx, dealerId: number, r: PosRequest, s: PosSnapshot, client: ErpnextClient, company: string) {
  // Already submitted remote invoices must be adopted, not rechecked against
  // pre-sale ERP stock (which has already been relieved).
  const marker = `AURA POS ${dealerId}/${r.id} invoice`;
  const existing = await client.listDocs<{ name: string; docstatus: number }>("Sales Invoice", {
    filters: [["company", "=", company], ["remarks", "=", marker], ["docstatus", "=", 1]], fields: ["name", "docstatus"], limit: 1,
  });
  for (const l of [...s.lines].sort((a,b) => a.partId-b.partId)) {
    const { part, location } = await ensureInventory(tx, dealerId, l.partId);
    const [level] = await tx.select().from(inventoryLevelsTable).where(and(eq(inventoryLevelsTable.dealerId, dealerId),
      eq(inventoryLevelsTable.partId, l.partId), eq(inventoryLevelsTable.locationId, location.id), sql`${inventoryLevelsTable.binId} is null`)).for("update");
    if (r.kind === "sale") {
      if (!part.active || part.costingMethod !== "average" || !level || level.quantityOnHand - level.quantityReserved - level.quantityNonSellable < l.quantity)
        throw new Error(`${l.sku}: available local stock changed; Finance must reconcile before retrying`);
      if (Math.abs(level.averageUnitCost - l.unitCost) > 0.00001) throw new Error(`${l.sku}: moving-average cost changed after approval`);
      if (!existing.length) {
        const bins = await client.listDocs<{ actual_qty: number; valuation_rate: number }>("Bin", {
          filters: [["item_code", "=", l.itemCode], ["warehouse", "=", l.warehouse]], fields: ["actual_qty", "valuation_rate"], limit: 1,
        });
        if (!bins[0] || bins[0].actual_qty < l.quantity || Math.abs(bins[0].valuation_rate - l.unitCost) > 0.00001)
          throw new Error(`${l.sku}: ERP stock/valuation does not match the approved AURA moving-average cost; load/reconcile opening stock first`);
      }
    }
  }
}
export async function postPartsPosRequest(job: ErpnextSyncJob) {
  try {
    return await db.transaction(async tx => {
      await posLock(tx, job.dealerId);
      const [r] = await tx.select().from(requests).where(and(eq(requests.dealerId, job.dealerId), eq(requests.id, job.entityId))).for("update");
      if (!r || r.status === "posted") return { docName: r?.erpDocuments[0]?.name ?? null };
      if (!["approved", "failed"].includes(r.status) || !r.decidedBy || r.decidedBy === r.createdBy) throw new Error("Independent Finance approval is required");
      const s = r.snapshot as unknown as PosSnapshot;
      const input = posInputSchema.parse(r.input);
      const currentConnection = await getErpnextConnection(job.dealerId);
      if (s.erpSite !== currentConnection?.siteUrl || s.erpCompany !== currentConnection?.companyName)
        throw new Error("ERP target changed since approval; do not post this request to another company");
      const { client, company } = await validateConfig(job.dealerId, s.config);
      const docs: { doctype: string; name: string }[] = [];
      const prefix = `AURA POS ${job.dealerId}/${r.id}`;
      const account = (name: string, debit: number, credit: number, extra: Record<string, unknown> = {}) => ({
        account: name, debit_in_account_currency: debit, credit_in_account_currency: credit,
        cost_center: s.config.costCenter, ...extra,
      });
      if (r.kind === "shift_close") {
        const cash = source(s.config, input.sourceId);
        const variance = s.variance ?? 0;
        if (variance !== 0) docs.push(await document(client, company, "Journal Entry", `${prefix} variance`, {
          voucher_type: "Journal Entry", posting_date: s.date, accounts: variance < 0
            ? [account(s.config.overShort, -variance, 0), account(cash.account, 0, -variance)]
            : [account(cash.account, variance, 0), account(s.config.overShort, 0, variance)],
        }));
        const transfer = money(input.transferAmount ?? 0);
        if (transfer > 0) docs.push(await document(client, company, "Journal Entry", `${prefix} transfer`, {
          voucher_type: "Journal Entry", posting_date: s.date,
          accounts: [account(source(s.config, input.destinationSourceId).account, transfer, 0), account(cash.account, 0, transfer)],
        }));
      } else {
        s.erpCustomer = await customer(client, job.dealerId, r, s);
        let invoiceName: string;
        if (r.kind === "sale" || r.kind === "return") {
          await stockPreflight(tx, job.dealerId, r, s, client, company);
          let returnAgainst: string | undefined;
          if (r.kind === "return") {
            const [original] = await tx.select().from(requests).where(and(eq(requests.dealerId, job.dealerId), eq(requests.id, input.originalId!)));
            returnAgainst = original?.erpDocuments.find(d => d.doctype === "Sales Invoice")?.name;
            if (!returnAgainst) throw new Error("Original ERP sales invoice is missing");
          }
          const sign = r.kind === "return" ? -1 : 1;
          const invoice = await document(client, company, "Sales Invoice", `${prefix} invoice`, {
            customer: s.erpCustomer, posting_date: s.date, due_date: s.date, currency: "GYD", conversion_rate: 1,
            debit_to: s.config.receivable, update_stock: 1, ignore_pricing_rule: 1, disable_rounded_total: 1,
            ...(returnAgainst ? { is_return: 1, return_against: returnAgainst, update_outstanding_for_self: 1 } : {}),
            items: s.lines.map(l => ({
              item_code: l.itemCode, qty: sign * l.quantity, rate: l.unitPrice,
              income_account: l.income, expense_account: l.cogs, warehouse: l.warehouse,
              cost_center: s.config.costCenter, ...(sign < 0 ? { incoming_rate: l.unitCost } : {}),
            })),
            taxes: s.tax ? [{ charge_type: "Actual", account_head: s.config.vat, tax_amount: sign * s.tax,
              description: `VAT ${s.config.taxRate}%`, cost_center: s.config.costCenter }] : [],
          }, sign * s.total);
          docs.push(invoice);
          invoiceName = invoice.name;
        } else {
          const [original] = await tx.select().from(requests).where(and(eq(requests.dealerId, job.dealerId), eq(requests.id, input.originalId!)));
          const name = original?.erpDocuments.find(d => d.doctype === "Sales Invoice")?.name;
          if (!name) throw new Error("Original ERP sales invoice is missing");
          invoiceName = name;
        }
        for (const [i,t] of (input.tenders ?? []).entries()) {
          const amount = money(t.amount);
          const extra = { party_type: "Customer", party: s.erpCustomer, reference_type: "Sales Invoice", reference_name: invoiceName };
          const receiving = source(s.config, t.sourceId).account;
          docs.push(await document(client, company, "Journal Entry", `${prefix} tender ${i}`, {
            voucher_type: "Journal Entry", posting_date: s.date,
            accounts: r.kind === "return"
              ? [account(s.config.receivable, amount, 0, extra), account(receiving, 0, amount)]
              : [account(receiving, amount, 0), account(s.config.receivable, 0, amount, extra)],
          }));
        }
        // The Sales Invoice itself handles ERP stock/COGS. Never enqueue an
        // additional Stock Entry for these movements.
        for (const l of s.lines) await moveStock(tx, {
          dealerId: job.dealerId, partId: l.partId, quantityDelta: (r.kind === "return" ? 1 : -1) * l.quantity,
          type: r.kind === "return" ? "return" : "issue", referenceType: "parts_pos", referenceId: String(r.id),
          idempotencyKey: `pos:${job.dealerId}:${r.id}:${l.partId}`, unitCost: l.unitCost, createdBy: r.decidedBy,
          notes: r.kind === "return" ? "F2 sellable goods physically returned; original cost restored" : "F2 approved POS sale",
        });
      }
      await tx.update(requests).set({ status: "posted", snapshot: s, erpDocuments: docs, error: null, updatedAt: new Date() }).where(eq(requests.id, r.id));
      return { docName: docs[0]?.name ?? null };
    });
  } catch (error) {
    // Don't expose remote payloads or credentials. Keep a useful validation
    // message for our own errors; detailed provider errors stay in queue logs.
    const message = error instanceof Error && error.name !== "ErpnextError" ? error.message : "ERPNext rejected the posting. Review the sync log and ERP draft; retry adopts existing documents.";
    await db.update(requests).set({ status: "failed", error: message, updatedAt: new Date() })
      .where(and(eq(requests.dealerId, job.dealerId), eq(requests.id, job.entityId), sql`${requests.status} in ('approved','failed')`));
    throw error;
  }
}
export function registerPartsPosSync() {
  registerErpnextSyncHandler("AURA Parts POS", postPartsPosRequest);
  registerErpnextSyncHandler("AURA Parts POS Validation", async job => {
    const [row] = await db.select().from(settings).where(and(eq(settings.dealerId, job.dealerId), eq(settings.revision, Number(job.payload.revision))));
    if (!row) return { docName: null };
    let errors: string[] = [];
    try { await validateConfig(job.dealerId, posConfigSchema.parse(row.config)); }
    catch (error) { errors = [error instanceof Error ? error.message : "ERP mapping validation failed"]; }
    await db.update(settings).set({ validation: { state: errors.length ? "invalid" : "valid", errors } })
      .where(and(eq(settings.dealerId, job.dealerId), eq(settings.revision, row.revision)));
    return { docName: null };
  });
}
