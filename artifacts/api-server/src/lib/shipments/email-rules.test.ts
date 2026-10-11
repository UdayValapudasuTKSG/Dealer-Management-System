import { test } from "node:test";
import assert from "node:assert/strict";
import { shipmentEmailEligible } from "./rules";
const valid = {
  production: true, shipmentStatus: "open", allocationStatus: "active", jobStatus: "queued",
  currentEta: "2026-11", eventEta: "2026-11", leadMatches: true,
  kind: "initial", now: new Date("2026-10-12T12:00:00Z"), timezone: "America/Guyana",
};
test("new eligible allocation and retry qualify", () => {
  assert.equal(shipmentEmailEligible(valid), true);
  assert.equal(shipmentEmailEligible({ ...valid, jobStatus: "failed" }), true);
});
test("development and historical withheld events never send automatically", () => {
  assert.equal(shipmentEmailEligible({ ...valid, production: false }), false);
  for (const jobStatus of ["withheld", "suppressed", "superseded", "sent"])
    assert.equal(shipmentEmailEligible({ ...valid, jobStatus }), false);
});
test("released/reassigned demand, changed ETA, wrong lead and closed shipments are blocked", () => {
  for (const allocationStatus of ["released", "reassigned"])
    assert.equal(shipmentEmailEligible({ ...valid, allocationStatus }), false);
  assert.equal(shipmentEmailEligible({ ...valid, currentEta: "2027-01" }), false);
  assert.equal(shipmentEmailEligible({ ...valid, leadMatches: false }), false);
  for (const shipmentStatus of ["closed", "cancelled"])
    assert.equal(shipmentEmailEligible({ ...valid, shipmentStatus }), false);
});
test("initial can announce later arrival, ETA change must be in current/next month", () => {
  const later = { ...valid, eventEta: "2027-01", currentEta: "2027-01" };
  assert.equal(shipmentEmailEligible(later), true);
  assert.equal(shipmentEmailEligible({ ...later, kind: "eta_change" }), false);
  assert.equal(shipmentEmailEligible({ ...valid, kind: "eta_change" }), true);
});
