import assert from "node:assert/strict";
import { zonedDayKey } from "../lib/timezone";
import {
  aggregateTechnicianMetrics,
  calculateTechnicianMetrics,
} from "../lib/technician-timesheet-metrics";

const row = calculateTechnicianMetrics({
  availableHours: 8,
  bookedHours: 10,
  approvedSoldHours: 4,
  invoicedSoldHours: 2,
  invoicedHoursKnown: true,
  loggedActualHours: 2,
  existingTimerHours: 12,
});
assert.equal(row.remainingCapacityHours, -2, "overbooking remains visible");
assert.equal(row.efficiencyPct, 200, "approved sold hours stay separate");
assert.equal(row.productivityPct, 100, "invoiced sold hours stay separate");

const zeroActual = calculateTechnicianMetrics({
  availableHours: 8,
  bookedHours: 0,
  approvedSoldHours: 2,
  invoicedSoldHours: 1,
  invoicedHoursKnown: true,
  loggedActualHours: 0,
  existingTimerHours: 0,
});
assert.equal(zeroActual.efficiencyPct, null, "zero actuals never produce a fake percentage");
assert.equal(zeroActual.productivityPct, null);

const cancelledExcluded = [
  { status: "completed", metrics: row },
  { status: "cancelled", metrics: calculateTechnicianMetrics({ ...row, approvedSoldHours: 99, invoicedSoldHours: 99 }) },
]
  .filter((item) => item.status !== "cancelled")
  .map((item) => item.metrics);
const team = aggregateTechnicianMetrics(cancelledExcluded);
assert.equal(team.approvedSoldHours, 4, "cancelled work is excluded before aggregation");
assert.equal(team.invoicedSoldHours, 2);

const isolatedA = calculateTechnicianMetrics({ ...row, approvedSoldHours: 3 });
const isolatedB = calculateTechnicianMetrics({ ...row, approvedSoldHours: 7 });
assert.equal(isolatedA.approvedSoldHours, 3, "technician rows do not share mutable totals");
assert.equal(isolatedB.approvedSoldHours, 7);

assert.equal(
  zonedDayKey(new Date("2026-09-30T02:30:00.000Z"), "America/Guyana"),
  "2026-09-29",
  "report dates use the dealer timezone",
);

console.log("Technician timesheet aggregate checks passed");