import assert from "node:assert/strict";
import {
  canCreateCommittedDealForVehicle,
  hasUnsafeReusableFinance,
  identityImportPlan,
  isExplicitLeadOutboxSuppressed,
  isReusableCommittedDeal,
  legacyReviewedOutboxDisposition,
  matchesReviewedVehicle,
  requiresApplyIdentityConfirmation,
  suppressesReviewedImportedLead,
} from "../lib/reviewed-delivery-import-policy";

const input = { modelYear: 2026, vehicleMake: "Example", powertrain: "Hybrid", bodyType: "SUV" };
const row = {
  sellingPrice: 12_500_000,
  raw: { Model: "Atlas", Version: "Premium", "Engine No": "ENG 42", Exterior: "Silver" },
};
const vehicle = {
  make: "Example", model: "Atlas", trim: "Premium", year: 2026,
  engineNumber: "ENG 42", price: 12_500_000, powertrain: "Hybrid",
  bodyType: "SUV", exteriorColor: "Silver",
};

// Missing records create a lead/customer/deal without any confirmation.
assert.deepEqual(identityImportPlan([], [], [], false), {
  leadAction: "create_lead", leadId: null,
  customerAction: "create_customer", customerId: null,
  dealAction: "create_deal", dealId: null,
  requiresIdentityConfirmation: false,
});
// Exact reuse requires manual confirmation, while a verified retry is inert.
assert.equal(identityImportPlan([41], [51], [61], false).requiresIdentityConfirmation, true);
assert.equal(identityImportPlan([41], [51], [61], true).requiresIdentityConfirmation, false);
assert.equal(identityImportPlan([41, 42], [], [], false).leadId, null);
assert.equal(requiresApplyIdentityConfirmation(identityImportPlan([41], [], [], true)), false);
assert.equal(requiresApplyIdentityConfirmation(identityImportPlan([41], [], [], false)), true);

// This is the actual create guard used after the selected vehicle is resolved:
// a previously missing VIN is allowed; only a persisted unavailable unit blocks.
assert.equal(canCreateCommittedDealForVehicle(undefined), true);
assert.equal(canCreateCommittedDealForVehicle({ status: "available" }), true);
assert.equal(canCreateCommittedDealForVehicle({ status: "booked" }), false);

assert.equal(matchesReviewedVehicle(vehicle, row, input), true);
assert.equal(matchesReviewedVehicle({ ...vehicle, engineNumber: "ENG-42" }, row, input), false);
assert.equal(isReusableCommittedDeal({
  vehicleId: 7, customerId: 51, leadId: 41, stage: "committed",
  vehiclePrice: 12_500_000, otdPrice: 12_500_000,
}, 7, 51, 41, 12_500_000), true);
assert.equal(isReusableCommittedDeal({
  vehicleId: 7, customerId: 99, leadId: 41, stage: "committed",
  vehiclePrice: 12_500_000, otdPrice: 12_500_000,
}, 7, 51, 41, 12_500_000), false);
assert.equal(isReusableCommittedDeal({
  vehicleId: 7, customerId: 51, leadId: 41, stage: "cancelled",
  vehiclePrice: 12_500_000, otdPrice: 12_500_000,
}, 7, 51, 41, 12_500_000), false);

assert.equal(hasUnsafeReusableFinance([{ amount: 12_500_000, status: "issued", paymentCount: 0, taxLines: [] }], 12_500_000), false);
assert.equal(hasUnsafeReusableFinance([{ amount: 12_500_000, status: "paid", paymentCount: 1, taxLines: [] }], 12_500_000), true);
assert.equal(hasUnsafeReusableFinance([{ amount: 12_500_000, status: "issued", paymentCount: 0, taxLines: [{ code: "VAT" }] }], 12_500_000), true);

assert.equal(suppressesReviewedImportedLead({
  suppressCustomerCommunications: true, suppressSalesAutomation: true,
}), true);
assert.equal(suppressesReviewedImportedLead({ suppressCustomerCommunications: true }), false);
assert.equal(isExplicitLeadOutboxSuppressed(41, {
  suppressCustomerCommunications: true, suppressSalesAutomation: true,
}), true);
// Same-address records cannot be affected without the imported lead's explicit ID.
assert.equal(isExplicitLeadOutboxSuppressed(null, {
  suppressCustomerCommunications: true, suppressSalesAutomation: true,
}), false);

const reviewedImport = {
  suppressCustomerCommunications: true,
  suppressSalesAutomation: true,
  importedAt: "2026-08-01T12:00:00.000Z",
};
assert.equal(
  legacyReviewedOutboxDisposition(
    [{ importMetadata: reviewedImport }],
    { template: "vehicle_quote", createdAt: new Date("2026-07-31T12:00:00.000Z") },
  ),
  "suppress",
  "a pre-import leadless sales message is suppressed",
);
assert.equal(
  legacyReviewedOutboxDisposition(
    [{ importMetadata: reviewedImport }],
    { template: "delivery_schedule", createdAt: new Date("2026-07-31T12:00:00.000Z") },
  ),
  "suppress",
  "a pre-import leadless delivery message is suppressed",
);
for (const template of [
  "service.appointment.confirmed",
  "service.appointment.reminder",
  "service.checkin.receipt",
  "service.estimate.ready",
  "service.invoice.issued",
  "service.delayed",
  "feedback.survey",
  "collision.claim.communication",
]) {
  assert.equal(
    legacyReviewedOutboxDisposition(
      [{ importMetadata: reviewedImport }],
      { template, createdAt: new Date("2026-07-31T12:00:00.000Z") },
    ),
    "allow",
    `${template} is outside the legacy sales/delivery scope`,
  );
}
assert.equal(
  legacyReviewedOutboxDisposition(
    [{ importMetadata: reviewedImport }],
    { template: "vehicle_quote", createdAt: new Date("2026-08-01T12:01:00.000Z") },
  ),
  "allow",
  "a future leadless sales event is outside the pre-import cutoff",
);
assert.equal(
  legacyReviewedOutboxDisposition(
    [{ importMetadata: reviewedImport }, { importMetadata: null }],
    { template: "vehicle_quote", createdAt: new Date("2026-07-31T12:00:00.000Z") },
  ),
  "cancel_ambiguous",
  "pre-import ambiguity still fails closed only for the legacy row",
);

console.log("Reviewed delivery import policy tests passed.");