import assert from "node:assert/strict";
import {
  calculateLabourRateGyd,
  resolveNewCardLabourRate,
} from "../lib/service-labour-pricing";
import { calculateQuotedLaborTotal } from "../lib/service-labor-hours";
import {
  clearEstimateStaffAcknowledgement,
  hasCurrentChargeableWorkAuthorization,
} from "../lib/service-estimate-gate";

assert.equal(calculateLabourRateGyd(209), 25080);
assert.equal(calculateQuotedLaborTotal(3, 0, calculateLabourRateGyd(209)), 75240);

for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
  assert.throws(() => calculateLabourRateGyd(invalid));
}

// A card snapshot remains its own GYD amount when the dealer setting changes.
const existingCardRate = resolveNewCardLabourRate(undefined, 209);
assert.equal(existingCardRate, 25080);
assert.equal(resolveNewCardLabourRate(undefined, 300), 36000);
assert.equal(existingCardRate, 25080);

// Explicit existing custom GYD rates are retained unless the action endpoint
// is deliberately invoked; no USD amount is accepted by this helper.
assert.equal(resolveNewCardLabourRate(27500, 209), 27500);
assert.throws(() => resolveNewCardLabourRate(Number.NaN, 209));

// Repricing is a new estimate version, so the old customer approval and staff
// receipt cannot authorize chargeable work on the replacement price.
const approvedCard = {
  payType: "customer",
  quoteTotal: 75240,
  estimateVersion: 1,
  estimateApprovedVersion: 1,
  estimateStaffAcknowledgedVersion: 1,
  estimateStaffAcknowledgedDecisionId: 42,
};
assert.equal(hasCurrentChargeableWorkAuthorization(approvedCard), true);
const repricedCard = {
  ...approvedCard,
  estimateVersion: 2,
  estimateApprovedVersion: null,
  ...clearEstimateStaffAcknowledgement,
};
assert.equal(hasCurrentChargeableWorkAuthorization(repricedCard), false);

process.stdout.write("service labour pricing checks passed\n");
