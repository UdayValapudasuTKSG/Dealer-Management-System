import assert from "node:assert/strict";
import { test } from "node:test";
import { reconciliationFlags, replenishmentCalculation, csv } from "./parts-operations-math";
import { partsSmsReadiness } from "./parts-operations-sms-config";

test("partial receipts permit invoices limited to received quantity", () => {
  assert.deepEqual(reconciliationFlags(10, 4, 4, 100, 102, 2), { quantityMismatch: false, priceMismatch: false, priceVariancePercent: 2, partiallyReceived: true });
  assert.equal(reconciliationFlags(10, 4, 5, 100, 100, 2).quantityMismatch, true);
  assert.equal(reconciliationFlags(10, 10, 11, 100, 100, 2).quantityMismatch, true);
});
test("zero-cost orders and price tolerance are handled explicitly", () => {
  assert.equal(reconciliationFlags(1, 1, 1, 0, 0, 2).priceMismatch, false);
  assert.equal(reconciliationFlags(1, 1, 1, 0, 1, 2).priceMismatch, true);
  assert.equal(reconciliationFlags(1, 1, 1, 100, 97.99, 2).priceMismatch, true);
  assert.equal(reconciliationFlags(1, 1, 1, 0.1, 0.102, 2).priceMismatch, false);
});
const base = { now: new Date("2026-09-18T00:00:00Z"), historyStart: new Date("2024-09-18T00:00:00Z"), leadTimeDays: 7, available: 1, pending: 0, min: 5, max: 20 };
test("same-season issue history carries more weight than opposite season", () => {
  const seasonal = replenishmentCalculation({ ...base, issues: [{ date: new Date("2025-09-18"), quantity: 100 }] });
  const offSeason = replenishmentCalculation({ ...base, issues: [{ date: new Date("2025-03-18"), quantity: 100 }] });
  assert.equal(seasonal.dailyVelocity, offSeason.dailyVelocity * 2);
});
test("pending orders suppress reorder and min/max cap target", () => {
  const r = replenishmentCalculation({ ...base, pending: 30, issues: [{ date: new Date("2025-09-18"), quantity: 10000 }] });
  assert.equal(r.target, 20);
  assert.equal(r.suggestedQuantity, 0);
  assert.ok(Number.isFinite(r.dailyVelocity));
});
test("CSV escapes quotes, newlines and spreadsheet formulas", () => {
  const output = csv([{ sku: 'A"B', name: "  =HYPERLINK(\"bad\")", quantity: 2 }]);
  assert.match(output, /A""B/);
  assert.match(output, /'  =HYPERLINK/);
  assert.equal(csv([]), "");
});
test("SMS requires explicit dealer opt-in and never uses voice/WhatsApp sender fallback", () => {
  const configured = { TWILIO_ACCOUNT_SID: "test-only", TWILIO_AUTH_TOKEN: "test-only", TWILIO_PHONE_NUMBER: "+15555550100", PARTS_SMS_DEALER_SENDERS: '{"2":{"enabled":true,"from":"+15555550101"}}' };
  assert.equal(partsSmsReadiness(1, configured).ready, false);
  assert.equal(partsSmsReadiness(2, configured).ready, true);
  assert.equal(partsSmsReadiness(2, { ...configured, PARTS_SMS_DEALER_SENDERS: '{"2":{"enabled":false,"from":"+15555550101"}}' }).ready, false);
  assert.equal(partsSmsReadiness(2, { ...configured, PARTS_SMS_DEALER_SENDERS: '{"2":{"enabled":true}}' }).ready, false);
  assert.equal(partsSmsReadiness(2, { ...configured, TWILIO_AUTH_TOKEN: undefined }).ready, false);
  assert.equal(partsSmsReadiness(2, { ...configured, PARTS_SMS_DEALER_SENDERS: "malformed" }).ready, false);
});