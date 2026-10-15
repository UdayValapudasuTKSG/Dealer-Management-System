import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateFinanceRequest, splitVat, ADVANCE_VAT_BLOCK, FINANCIER_BLOCK, SUPPLIER_PARTY_BLOCK } from "./sales-finance-policy";
import type { SalesAccountingConfigData } from "@workspace/db";

const config: SalesAccountingConfigData = {
  accounts: ["receivables", "vatOutput", "registration", "fuel", "detailing", "deposits"].map((k) => ({ key: k, account: k.toUpperCase() })),
  sources: [{ id: "bank", label: "Bank", kind: "bank", account: "BANK" }, { id: "sup", label: "Supplier", kind: "supplier", account: "AP" }, { id: "float", label: "Float", kind: "float", account: "FLOAT" }],
  models: [{ make: "BYD", model: "Atto", income: "SALES", dutyFreeIncome: "", inventory: "STOCK", cogs: "COGS", discount: "DISC" }],
  customerCharges: [{ category: "fuel", incomeAccount: "FUEL-REC", taxTreatment: "taxable", vatRate: 14, amountIncludesVat: true, approved: true, approvalReference: "FIN-1" }],
};
const vehicle = { make: "byd", model: "atto", dutyFree: false, vin: "VIN1" };
const base = { configValid: true, vehicle, dealStage: "committed" };

test("final invoice derives balanced DR receivable / CR income + VAT", () => {
  const r = evaluateFinanceRequest(config, { kind: "invoice", amountCents: 114000, reference: "INV" },
    { ...base, invoice: { kind: "final", status: "issued", amountCents: 114000, taxCents: 14000 } });
  assert.deepEqual(r.blockers, []); assert.deepEqual(r.policyBlocks, []);
  assert.equal(r.debitCents, 114000); assert.equal(r.creditCents, 114000);
  assert.ok(r.lines.some((l) => l.account === "SALES" && l.credit === 1000));
});
test("pending advance VAT blocks reservation invoices and deposit payments", () => {
  const inv = { kind: "reservation", status: "issued", amountCents: 5000, taxCents: 0 };
  assert.ok(evaluateFinanceRequest(config, { kind: "invoice", amountCents: 5000, reference: "R" }, { ...base, invoice: inv }).policyBlocks.includes(ADVANCE_VAT_BLOCK));
  assert.ok(evaluateFinanceRequest(config, { kind: "payment", amountCents: 5000, sourceId: "bank", payerType: "customer", reference: "R" },
    { ...base, invoice: inv, invoiceOutstandingCents: 5000 }).policyBlocks.includes(ADVANCE_VAT_BLOCK));
});
test("financier payment and supplier sources stay policy-blocked", () => {
  const inv = { kind: "final", status: "issued", amountCents: 5000, taxCents: 0 };
  assert.ok(evaluateFinanceRequest(config, { kind: "payment", amountCents: 100, sourceId: "bank", payerType: "financier", reference: "R" },
    { ...base, invoice: inv, invoicePosted: true, invoiceOutstandingCents: 5000 }).policyBlocks.includes(FINANCIER_BLOCK));
  assert.ok(evaluateFinanceRequest(config, { kind: "expense", amountCents: 100, category: "fuel", sourceId: "sup", billingTreatment: "dealer_paid", reference: "R" }, base)
    .policyBlocks.includes(SUPPLIER_PARTY_BLOCK));
});
test("payment overpayment and unposted invoice are blockers", () => {
  const inv = { kind: "final", status: "issued", amountCents: 5000, taxCents: 0 };
  const r = evaluateFinanceRequest(config, { kind: "payment", amountCents: 6000, sourceId: "bank", payerType: "customer", reference: "R" },
    { ...base, invoice: inv, invoicePosted: false, invoiceOutstandingCents: 5000 });
  assert.ok(r.blockers.some((b) => b.includes("overpayment")));
  assert.ok(r.blockers.some((b) => b.includes("Post the invoice")));
});
test("customer-billed expense keeps cost separate from charge and requires category rule", () => {
  const ok = evaluateFinanceRequest(config, { kind: "expense", amountCents: 5000, category: "fuel", sourceId: "float", billingTreatment: "customer_billed", customerChargeCents: 11400, reference: "F" }, base);
  assert.deepEqual(ok.blockers, []);
  assert.equal(ok.chargeNetCents, 10000); assert.equal(ok.chargeVatCents, 1400);
  assert.equal(ok.debitCents, 16400);
  const missing = evaluateFinanceRequest(config, { kind: "expense", amountCents: 5000, category: "registration", sourceId: "float", billingTreatment: "customer_billed", customerChargeCents: 100, reference: "F" }, base);
  assert.ok(missing.blockers.some((b) => b.includes("customer-charge")));
});
test("invalid config validation, duty-free income and held legacy fail explicitly", () => {
  const r = evaluateFinanceRequest(config, { kind: "invoice", amountCents: 100, reference: "X" },
    { ...base, configValid: false, legacyHeld: true, vehicle: { ...vehicle, dutyFree: true }, invoice: { kind: "final", status: "issued", amountCents: 100, taxCents: 0 } });
  assert.ok(r.blockers.some((b) => b.includes("validation")));
  assert.ok(r.blockers.some((b) => b.includes("duty-free")));
  assert.ok(r.policyBlocks.some((b) => b.includes("review hold")));
});
test("VAT split is exact in cents", () => {
  assert.deepEqual(splitVat(11400, 14, true), { net: 10000, vat: 1400 });
  assert.deepEqual(splitVat(10000, 14, false), { net: 10000, vat: 1400 });
  assert.deepEqual(splitVat(999, 0, true), { net: 999, vat: 0 });
});

import { pilotDealerName, isSalesInvoiceShape } from "./sales-finance-boundary";
test("pilot boundary: exact dealer in production, sales shape excludes parts/service", () => {
  const prev = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "production";
    assert.equal(pilotDealerName(2, "CAM Motors Dummy"), true);
    assert.equal(pilotDealerName(7, "CAM Motors Dummy"), false);
    assert.equal(pilotDealerName(2, "CAM Motors Dummy (dev fixture x)"), false);
    process.env.NODE_ENV = "development";
    assert.equal(pilotDealerName(910, "CAM Motors Dummy (dev fixture browser)"), true);
    assert.equal(pilotDealerName(1, "GT Automotive"), false);
  } finally { process.env.NODE_ENV = prev; }
  assert.equal(isSalesInvoiceShape({ dealId: 5 }), true);
  assert.equal(isSalesInvoiceShape({ dealId: null, description: "Reservation fee (booking #12)" }), true);
  assert.equal(isSalesInvoiceShape({ dealId: null, description: "OTC parts sale" }), false);
  assert.equal(isSalesInvoiceShape({ dealId: null, description: null }), false);
});

import { authorizedJournalAccounts, authorizedPostingDate, authorizedSalesInvoiceFields, type AuthorizedPosting } from "./erpnext/authorized-payload";
const auth: AuthorizedPosting = { requestId: 9, date: "2026-10-03", receivable: "Debtors - GA", vatOutput: "VAT - GA", incomeAccount: "Sales - GA", paidTo: "Bank - GA",
  journalLines: [{ account: "Fuel - GA", debit: 50, credit: 0, purpose: "Fuel cost" }, { account: "Float - GA", debit: 0, credit: 50, purpose: "Funding" }] };
test("authorized Sales Invoice sets debit_to and the approved date", () => {
  assert.deepEqual(authorizedSalesInvoiceFields(auth), { debit_to: "Debtors - GA", set_posting_time: 1, posting_date: "2026-10-03" });
  assert.throws(() => authorizedSalesInvoiceFields({ ...auth, receivable: "" }), /debit_to/);
});
test("posting date: approved date when authorized, createdAt for legacy", () => {
  assert.equal(authorizedPostingDate(auth, new Date("2026-12-31T10:00:00Z")), "2026-10-03");
  assert.equal(authorizedPostingDate(undefined, new Date("2026-12-31T10:00:00Z")), "2026-12-31");
  assert.throws(() => authorizedPostingDate({ ...auth, date: "03/10/2026" }, new Date()), /YYYY-MM-DD/);
});
test("expense journal rows carry the company cost center; missing fails before creation", () => {
  const rows = authorizedJournalAccounts(auth, "Main - GA");
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.cost_center === "Main - GA"));
  assert.equal(rows[0]!.debit_in_account_currency, 50); assert.equal(rows[1]!.credit_in_account_currency, 50);
  assert.throws(() => authorizedJournalAccounts(auth, null), /cost center/);
  assert.throws(() => authorizedJournalAccounts(auth, "  "), /cost center/);
});
