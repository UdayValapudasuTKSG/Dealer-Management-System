import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { moneyMinor, decimalMoney, nonTaxChargeLines, assertDepositCreditWithinBalances } from "./parts-billing-money";
import { assertBillableRequisition, assertBillingCustomer } from "./parts-billing-policy";

test("money accepts fixed precision and rejects floats, signs, unsafe values and coercion", () => {
  assert.equal(moneyMinor("12.30"), 1230);
  assert.equal(decimalMoney(1230), "12.30");
  for (const bad of ["-1", "1.001", "NaN", "Infinity", "", null, undefined, "1e3", "9999999999999999"]) {
    assert.throws(() => moneyMinor(bad));
  }
});

test("charges remain separate, non-taxable, and zero charges disappear from document lines", () => {
  assert.deepEqual(nonTaxChargeLines(0, 0), []);
  const lines = nonTaxChargeLines(25.5, 12);
  assert.deepEqual(lines.map(l => l.description), ["Shipping", "Duties"]);
  const partsSubtotal = 100;
  const tax = 14; // existing tax engine's result for parts, never recalculated on charges
  assert.equal(partsSubtotal + tax + lines.reduce((sum, line) => sum + line.amount, 0), 151.5);
});

test("internal restock and collision requisitions cannot become customer invoices", () => {
  assert.throws(() => assertBillableRequisition({ serviceOrderId: null, jobCardId: null, collisionClaimId: null, status: "fulfilled" }), /Internal/);
  assert.throws(() => assertBillableRequisition({ serviceOrderId: 1, jobCardId: 2, collisionClaimId: 3, status: "fulfilled" }), /Collision/);
  assert.throws(() => assertBillableRequisition({ serviceOrderId: 1, jobCardId: 2, collisionClaimId: null, status: "approved" }), /Fulfill/);
  assert.doesNotThrow(() => assertBillableRequisition({ serviceOrderId: 1, jobCardId: 2, collisionClaimId: null, status: "fulfilled" }));
});

test("customer association is exact, not customer name or staff-provided customer id", () => {
  assert.doesNotThrow(() => assertBillingCustomer(12, 12));
  assert.throws(() => assertBillingCustomer(12, 13));
  assert.throws(() => assertBillingCustomer(null, null));
  assert.throws(() => assertBillingCustomer(12, undefined));
});

test("deposit is capped at both real deposited balance and target invoice balance", () => {
  assert.doesNotThrow(() => assertDepositCreditWithinBalances(500, 500, 800));
  assert.doesNotThrow(() => assertDepositCreditWithinBalances(500, 800, 500));
  for (const values of [[501, 500, 800], [501, 800, 500], [0, 500, 500], [-1, 500, 500], [1.5, 500, 500]]) {
    assert.throws(() => assertDepositCreditWithinBalances(values[0], values[1], values[2]));
  }
});

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
test("source duplicate guards are transaction-scoped and cross-source lines have a unique database guard", () => {
  const source = read("./parts-customer-billing.ts");
  const migration = read("../../../../lib/db/migrations/2026-09-27-parts-customer-billing.sql");
  assert.match(source, /db\.transaction[\s\S]*pg_advisory_xact_lock[\s\S]*existingPartsInvoice/);
  assert.match(migration, /UNIQUE \(dealer_id, source_type, source_id\)/);
  assert.match(migration, /PRIMARY KEY \(dealer_id, requisition_line_id\)/);
  assert.match(migration, /PRIMARY KEY \(dealer_id, job_card_part_id\)/);
  assert.match(source, /hasCurrentChargeableWorkAuthorization/);
  assert.match(source, /issueJobParts/);
  assert.match(source, /eq\(purchaseOrderLinesTable\.dealerId, dealerId\)/);
});

test("service conversion and printable PDF use immutable non-tax charge snapshot", () => {
  const routes = read("../routes/service.ts");
  const pdf = read("./document-pdfs.ts");
  const estimate = read("./service-estimate-breakdown.ts");
  assert.match(routes, /snapshotServicePartsCharges\(tx, card\.dealerId, created\.id, lockedBreakdown\)/);
  assert.match(routes, /loadServiceInvoicePartsCharges\(invoice\.dealerId, invoice\.id\)/);
  assert.match(read("./email.ts"), /loadServiceInvoicePartsCharges\(svcInvoice\.dealerId, svcInvoice\.id\)/);
  assert.match(pdf, /if \(charges\.shippingTotal\) lines\.push/);
  assert.match(pdf, /if \(charges\.dutiesTotal\) lines\.push/);
  assert.match(estimate, /computeServiceTax\(subtotal, taxes\)[\s\S]*taxed\.total \+ shippingTotal \+ dutiesTotal/);
});

test("deposit transfer locks authentic invoices and never fabricates a receipt", () => {
  const source = read("./invoicing.ts").split("export async function applyPartsDepositCredit(")[1].split("export type ApplyPaymentArgs")[0];
  assert.match(source, /orderBy\(invoicesTable\.id\)\.for\("update"\)/);
  assert.match(source, /deposit\.customerId !== args\.customerId/);
  assert.match(source, /sum\(\$\{paymentsTable\.amount\}\)/);
  assert.match(source, /assertDepositCreditWithinBalances/);
  assert.doesNotMatch(source, /insert\(receiptsTable\)/);
});