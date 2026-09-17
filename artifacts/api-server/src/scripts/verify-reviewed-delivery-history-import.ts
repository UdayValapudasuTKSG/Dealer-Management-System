/**
 * Cheap development regression guard. It intentionally does not connect to a
 * database or start the service; integration authorization tests belong to
 * the deployment environment with authenticated dealer fixtures.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../../..");
const csvPath = resolve(root, "exports/gt-automotive-august-2026-review.csv");
const routePath = resolve(root, "artifacts/api-server/src/routes/delivery-imports.ts");
const deliveriesPath = resolve(root, "artifacts/api-server/src/routes/deliveries.ts");
const emailPath = resolve(root, "artifacts/api-server/src/lib/email-triggers.ts");
const EXPECTED =
  "b89d087d5f91ac6fc97b10f230a32286ece974d552684d564ea9200bdc203a0f";

const csv = await readFile(csvPath);
const rows = csv.toString("utf8").trimEnd().split(/\r?\n/);
if (rows.length !== 11) throw new Error(`Expected header plus ten rows, got ${rows.length}.`);
if (createHash("sha256").update(csv).digest("hex") !== EXPECTED)
  throw new Error("Approved source CSV digest changed; create a new explicitly reviewed batch instead.");
const [route, deliveries, emails] = await Promise.all([
  readFile(routePath, "utf8"),
  readFile(deliveriesPath, "utf8"),
  readFile(emailPath, "utf8"),
]);
for (const required of [
  "EXPECTED_SOURCE_DIGEST",
  "vehicle-vin:${dealerId}",
  "pg_advisory_xact_lock",
  "const outcomes = await db.transaction",
  "isGeneralManager === true",
  "suppressCustomerCommunications: true",
  "paymentState: \"UNRECORDED\"",
]) {
  if (!route.includes(required)) throw new Error(`Import safety regression: missing ${required}.`);
}
for (const required of [
  "if (!skipping || step === \"delivery\")",
  "A final settlement invoice is required before handover",
  "Imported settlement requires ledger-backed payment",
  "isApprovedHistoricalSettlement",
  "const historicalSettlementRecord = isApprovedHistoricalSettlement",
  'step === "delivery" && historicalSettlementRecord',
  "historicalSettlementConfirmed: true",
  'paymentState: "UNRECORDED"',
  "handoverAt: null",
  "if (parsed.data.deliveredAt && !historicalSettlementRecord)",
  "HISTORICAL_SETTLEMENT_AUDIT_NOTE",
  "historicalSettlementAcknowledged",
  "deliveredAt: delivery.deliveredAt!",
]) {
  if (!deliveries.includes(required)) throw new Error(`Handover gate regression: missing ${required}.`);
}
const finalizationStart = deliveries.indexOf("// Handover side effects on the final step.");
if (finalizationStart < 0)
  throw new Error("Handover gate regression: finalization block is missing.");
if (deliveries.indexOf("const historicalSettlementRecord") > finalizationStart)
  throw new Error("Historical finalization regression: record predicate is not available to finalization.");
const finalization = deliveries.slice(finalizationStart);
if (!finalization.includes("historicalSettlementRecord"))
  throw new Error("Historical finalization regression: record-level guard is missing.");
if (finalization.includes("historicalSettlementAcknowledged"))
  throw new Error("Historical finalization regression: step-level acknowledgement leaked into finalization.");
for (const terminalStep of ["signature", "warranty", "feedback"]) {
  if (!deliveries.includes(`case "${terminalStep}"`))
    throw new Error(`Historical finalization regression: ${terminalStep} path is missing.`);
}
if (!deliveries.includes('switch (skipping ? ("__skipped__" as DeliveryStep) : step)'))
  throw new Error("Historical finalization regression: skipped-step path is missing.");
for (const forbidden of [
  "deliveredAt: delivery.deliveredAt ?? new Date()",
  "delivery.deliveredAt ?? new Date()",
]) {
  if (deliveries.includes(forbidden))
    throw new Error(`Historical handover regression: invented date fallback remains (${forbidden}).`);
}
for (const required of [
  "deliverySuppressesCustomerCommunications",
  "onDeliveryAdvisorAssigned",
  "onDeliveryCompleted",
]) {
  if (!emails.includes(required)) throw new Error(`Communication suppression regression: missing ${required}.`);
}
console.log("Reviewed delivery-history import static safeguards verified.");