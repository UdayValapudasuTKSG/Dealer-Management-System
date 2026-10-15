import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSalesPreview, ACCOUNT_ROLES } from "./sales-accounting-policy";
import type { SalesAccountingConfigData } from "@workspace/db";

const config: SalesAccountingConfigData = {
  accounts: ACCOUNT_ROLES.map(r => ({ key: r.key, account: r.key })),
  sources: [{ id: "bank", label: "Test Bank", kind: "bank", account: "BANK" }],
  models: [{ make: " BYD ", model: "Test   EV", income: "SALES", dutyFreeIncome: "DUTYFREE", inventory: "STOCK", cogs: "COGS", discount: "DISCOUNT" }],
};
const vehicle = { make: "byd", model: "test ev", dutyFree: false };
test("customer charges fail closed without approved category rules", () => {
  const p = buildSalesPreview(config, { stage: "VS-05", date: "2026-10-15", amount: 50, sourceId: "bank", expenseType: "fuel", billingTreatment: "customer_billed", customerChargeAmount: 100, reference: "Fuel" });
  assert.equal(p.lines.length, 2);
  assert.ok(p.blockers.some(b => b.includes("Finance must configure")));
});
test("customer charge VAT inclusive/exclusive previews are separate and balanced", () => {
  for (const amountIncludesVat of [true, false]) {
    const c: SalesAccountingConfigData = { ...config, customerCharges: [{ category: "fuel", incomeAccount: "RECOVERY", taxTreatment: "taxable", vatRate: 14, amountIncludesVat, approved: true, approvalReference: "Finance policy" }] };
    const p = buildSalesPreview(c, { stage: "VS-05", date: "2026-10-15", amount: 50, sourceId: "bank", expenseType: "fuel", billingTreatment: "customer_billed", customerChargeAmount: amountIncludesVat ? 114 : 100, reference: "Fuel" });
    assert.equal(p.debitTotal, 164);
    assert.equal(p.creditTotal, 164);
    assert.ok(p.lines.some(l => l.account === "RECOVERY" && l.credit === 100));
    assert.ok(p.lines.some(l => l.account === "vatOutput" && l.credit === 14));
    assert.ok(p.blockers.some(b => b.includes("posting is held")));
  }
});
test("exempt and zero-rated charges add no VAT and never borrow another category's approval", () => {
  for (const taxTreatment of ["exempt", "zero_rated"] as const) {
    const c: SalesAccountingConfigData = { ...config, customerCharges: [{ category: "registration", incomeAccount: "RECOVERY", taxTreatment, vatRate: 0, amountIncludesVat: false, approved: true, approvalReference: "Finance policy" }] };
    const input = { stage: "VS-05", date: "2026-10-15", amount: 10, sourceId: "bank", expenseType: "registration", billingTreatment: "customer_billed" as const, customerChargeAmount: 15, reference: "Registration" };
    const p = buildSalesPreview(c, input);
    assert.equal(p.debitTotal, 25);
    assert.equal(p.creditTotal, 25);
    assert.ok(!p.lines.some(l => l.account === "vatOutput"));
    assert.ok(buildSalesPreview(c, { ...input, expenseType: "fuel" }).blockers.some(b => b.includes("Finance must configure")));
    assert.equal(buildSalesPreview(c, { ...input, billingTreatment: "dealer_paid" }).debitTotal, 10);
  }
});
test("deposit preview holds full payment as liability but cannot post without VAT approval", () => {
  const p = buildSalesPreview(config, { stage: "VS-03", date: "2026-10-14", amount: 100.25, sourceId: "bank", reference: "Receipt" });
  assert.deepEqual(p.lines.map(l => [l.account, l.debit, l.credit]), [["BANK", 100.25, 0], ["deposits", 0, 100.25]]);
  assert.ok(p.blockers.some(b => b.includes("advance-VAT")));
});
test("invoice balances explicit discount, sales and VAT; duty-free map remains separate", () => {
  for (const dutyFree of [false, true]) {
    const p = buildSalesPreview(config, { stage: "VS-06", date: "2026-10-14", amount: 1140, discount: 100, vat: 140, reference: "Invoice" }, { ...vehicle, dutyFree });
    assert.equal(p.debitTotal, p.creditTotal);
    assert.ok(p.lines.some(l => l.account === (dutyFree ? "DUTYFREE" : "SALES") && l.credit === 1100));
    assert.ok(p.lines.some(l => l.account === "DISCOUNT" && l.debit === 100));
  }
});
test("missing model accounts never silently fall back to another model", () => {
  const p = buildSalesPreview(config, { stage: "VS-07", date: "2026-10-14", amount: 0, cost: 500, reference: "VIN cost", costEvidence: "Stock Ledger" }, { ...vehicle, model: "Other" });
  assert.ok(p.blockers.some(b => b.includes("cogs")));
  assert.ok(p.blockers.some(b => b.includes("inventory")));
});
test("PDI, deposit application, balance and refund previews balance", () => {
  for (const stage of ["VS-05", "VS-08", "VS-09", "VS-10"]) {
    const p = buildSalesPreview(config, { stage, date: "2026-10-14", amount: 75.55, sourceId: "bank", expenseType: "fuel", payerType: "customer", reference: "Evidence" }, vehicle);
    assert.equal(p.debitTotal, 75.55);
    assert.equal(p.creditTotal, 75.55);
    assert.ok(p.blockers.some(b => b.includes("posting is held")));
  }
});
test("quotation, order and bank matching do not fabricate GL lines", () => {
  for (const stage of ["VS-01", "VS-02", "VS-04"]) {
    assert.deepEqual(buildSalesPreview(config, { stage, date: "2026-10-14", amount: 0, reference: "Evidence" }).lines, []);
  }
});
