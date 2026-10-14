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
