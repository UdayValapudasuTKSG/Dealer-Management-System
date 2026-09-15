import assert from "node:assert/strict";
import {
  countModelYearBulkAffected,
  defaultVehicleYearForDealer,
  vehicleYearRequirementError,
  canNormalizeGtAutomotiveModelYears,
  GT_AUTOMOTIVE_DEALER_ID,
  GT_AUTOMOTIVE_DEFAULT_YEAR,
  isModelYearBulkAffected,
  modelYearBulkScope,
} from "../lib/model-year-bulk";
import { UpdateVehicleModelYear2026Body } from "@workspace/api-zod";
import { FIELD_GROUPS } from "@workspace/db/schema";
import { blockedEditFieldFromGrants } from "../lib/field-permission-policy";

const activeOldAvailable = {
  dealerId: GT_AUTOMOTIVE_DEALER_ID,
  deletedAt: null,
  year: 2025,
  status: "available",
};
const activeOldDelivered = {
  dealerId: GT_AUTOMOTIVE_DEALER_ID,
  deletedAt: null,
  year: 2024,
  status: "delivered",
};
const activeCurrent = {
  dealerId: GT_AUTOMOTIVE_DEALER_ID,
  deletedAt: null,
  year: GT_AUTOMOTIVE_DEFAULT_YEAR,
  status: "sold",
};
const deletedOld = {
  dealerId: GT_AUTOMOTIVE_DEALER_ID,
  deletedAt: new Date("2026-01-01T00:00:00.000Z"),
  year: 2020,
  status: "service",
};
const otherDealerOld = {
  dealerId: 2,
  deletedAt: null,
  year: 2020,
  status: "available",
};

assert.equal(isModelYearBulkAffected(activeOldAvailable), true);
assert.equal(isModelYearBulkAffected(activeOldDelivered), true);
assert.equal(isModelYearBulkAffected(activeCurrent), false);
assert.equal(isModelYearBulkAffected(deletedOld), false);
assert.equal(isModelYearBulkAffected(otherDealerOld), false);
assert.equal(
  countModelYearBulkAffected([
    activeOldAvailable,
    activeOldDelivered,
    activeCurrent,
    deletedOld,
    otherDealerOld,
  ]),
  2,
);

// Re-running after the first transaction is a no-op.
const normalized = [activeOldAvailable, activeOldDelivered].map((vehicle) => ({
  ...vehicle,
  year: GT_AUTOMOTIVE_DEFAULT_YEAR,
}));
assert.equal(countModelYearBulkAffected(normalized), 0);

assert.equal(
  defaultVehicleYearForDealer(GT_AUTOMOTIVE_DEALER_ID, undefined),
  GT_AUTOMOTIVE_DEFAULT_YEAR,
);
assert.equal(
  defaultVehicleYearForDealer(GT_AUTOMOTIVE_DEALER_ID, 2025),
  2025,
);
assert.equal(defaultVehicleYearForDealer(2, undefined), undefined);
assert.equal(defaultVehicleYearForDealer(2, 2025), 2025);
assert.equal(
  vehicleYearRequirementError(2, undefined),
  "Year is required for this dealership.",
);
assert.equal(vehicleYearRequirementError(2, 2025), null);
assert.equal(canNormalizeGtAutomotiveModelYears(1, true), true);
assert.equal(canNormalizeGtAutomotiveModelYears(1, false), false);
assert.equal(canNormalizeGtAutomotiveModelYears(2, true), false);

assert.deepEqual(modelYearBulkScope(), {
  dealerId: GT_AUTOMOTIVE_DEALER_ID,
  statuses: "all",
  includeDeleted: false,
});
assert.equal(UpdateVehicleModelYear2026Body.safeParse({ confirm: true }).success, true);
assert.equal(UpdateVehicleModelYear2026Body.safeParse({ confirm: false }).success, false);
assert.equal(UpdateVehicleModelYear2026Body.safeParse({}).success, false);

// The bulk action must pass through the same inventory field policy as a
// single vehicle edit. Model year is part of the existing vehicle identity
// group, so a role restricted from that group is denied by findBlockedEditField.
const vehicleIdentity = FIELD_GROUPS.find((group) => group.key === "vehicle_identity");
assert.ok(vehicleIdentity);
assert.ok(vehicleIdentity.fields.includes("year"));
assert.deepEqual(
  blockedEditFieldFromGrants(
    [{ group: vehicleIdentity, access: "view" }],
    { year: GT_AUTOMOTIVE_DEFAULT_YEAR },
  ),
  { field: "year", groupLabel: "Vehicle · VIN / engine / registration" },
);
assert.equal(
  blockedEditFieldFromGrants(
    [{ group: vehicleIdentity, access: "edit" }],
    { year: GT_AUTOMOTIVE_DEFAULT_YEAR },
  ),
  null,
);

process.stdout.write("model-year bulk policy tests passed\n");