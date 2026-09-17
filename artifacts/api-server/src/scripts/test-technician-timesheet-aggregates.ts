import assert from "node:assert/strict";
import { zonedDayKey } from "../lib/timezone";
import {
  aggregateTechnicianMetrics,
  calculateDealerTimerResidualHours,
  calculateTechnicianMetrics,
  manualJobDayKey,
  shouldCountAutomaticSlice,
  splitTimerSegmentByDealerDay,
} from "../lib/technician-timesheet-metrics";

const row = calculateTechnicianMetrics({
  availableHours: 8,
  bookedHours: 10,
  approvedSoldHours: 4,
  invoicedSoldHours: 2,
  invoicedHoursKnown: true,
  manualActualHours: 0.5,
  automaticActualHours: 1.5,
  capturedTimerHours: 10,
  existingTimerHours: 12,
});
assert.equal(row.remainingCapacityHours, -2, "overbooking remains visible");
assert.equal(row.efficiencyPct, 200, "approved sold hours stay separate");
assert.equal(row.productivityPct, 100, "invoiced sold hours stay separate");
assert.equal(row.manualActualHours, 0.5);
assert.equal(row.automaticActualHours, 1.5);
assert.equal(row.capturedActualHours, 2, "daily manual and automatic actuals combine");
assert.equal(row.unallocatedTimerHours, 0, "technician rows never invent an unallocated attribution");

const zeroActual = calculateTechnicianMetrics({
  availableHours: 8,
  bookedHours: 0,
  approvedSoldHours: 2,
  invoicedSoldHours: 1,
  invoicedHoursKnown: true,
  manualActualHours: 0,
  automaticActualHours: 0,
  capturedTimerHours: 0,
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

const midnightSlices = splitTimerSegmentByDealerDay(
  {
    id: 99,
    dealerId: 1,
    jobCardId: 4,
    technicianUserId: 7,
    technicianNameSnapshot: "Captured Technician",
    dealerTimezoneSnapshot: "America/Guyana",
    startedAt: new Date("2026-09-30T03:30:00.000Z"), // 23:30 Guyana, Sep 29
    endedAt: new Date("2026-09-30T05:30:00.000Z"), // 01:30 Guyana, Sep 30
  },
  "America/Guyana",
  new Date("2026-09-30T08:00:00.000Z"),
);
assert.deepEqual(
  midnightSlices.map((slice) => [slice.workDate, slice.durationSeconds]),
  [
    ["2026-09-29", 30 * 60],
    ["2026-09-30", 90 * 60],
  ],
  "timer sessions split at the dealer-local midnight",
);

const activeSlice = splitTimerSegmentByDealerDay(
  {
    id: 100,
    dealerId: 1,
    jobCardId: 5,
    technicianUserId: 7,
    technicianNameSnapshot: "Captured Technician",
    dealerTimezoneSnapshot: "America/Guyana",
    startedAt: new Date("2026-09-30T08:00:00.000Z"),
    endedAt: null,
  },
  "America/Guyana",
  new Date("2026-09-30T08:15:00.000Z"),
);
assert.equal(activeSlice[0]?.durationSeconds, 15 * 60, "active work clips at now");

const correctedJobs = new Set([manualJobDayKey(7, 4)]);
assert.equal(
  shouldCountAutomaticSlice(correctedJobs, 7, 4),
  false,
  "a pre-existing manual job/day entry visibly supersedes the automatic slice",
);
assert.equal(
  shouldCountAutomaticSlice(correctedJobs, 7, 5),
  true,
  "unrelated automatic work remains counted",
);

const residualHours = calculateDealerTimerResidualHours(
  [
    // Captured by the old technician, while the card may now be assigned to
    // somebody else: matching by card prevents a false new-tech residual.
    { jobCardId: 10, cumulativeTimerSeconds: 60 * 60 },
    // Cancellation does not erase the genuine legacy remainder.
    { jobCardId: 11, cumulativeTimerSeconds: 2 * 60 * 60 },
    // A card with no ledger is a genuine pre-deployment legacy remainder.
    { jobCardId: 12, cumulativeTimerSeconds: 30 * 60 },
  ],
  new Map([
    [10, 60 * 60],
    [11, 60 * 60],
    // Captured-only evidence for a deleted card is intentionally absent from
    // the retained-card input and therefore cannot create a negative residual.
    [99, 9 * 60 * 60],
  ]),
);
assert.equal(
  residualHours,
  1.5,
  "residuals reconcile per retained job card across reassignment, cancellation, deletion, and legacy time",
);

const springForwardSlices = splitTimerSegmentByDealerDay(
  {
    id: 101,
    dealerId: 1,
    jobCardId: 6,
    technicianUserId: 7,
    technicianNameSnapshot: "Captured Technician",
    dealerTimezoneSnapshot: "America/New_York",
    startedAt: new Date("2026-03-08T04:30:00.000Z"), // Mar 7, 23:30 EST
    endedAt: new Date("2026-03-08T07:30:00.000Z"), // Mar 8, 03:30 EDT
  },
  "America/New_York",
);
assert.deepEqual(
  springForwardSlices.map((slice) => [slice.workDate, slice.durationSeconds]),
  [
    ["2026-03-07", 30 * 60],
    ["2026-03-08", 150 * 60],
  ],
  "spring-forward day uses actual elapsed seconds rather than 24-hour arithmetic",
);

const fallBackSlices = splitTimerSegmentByDealerDay(
  {
    id: 102,
    dealerId: 1,
    jobCardId: 7,
    technicianUserId: 7,
    technicianNameSnapshot: "Captured Technician",
    dealerTimezoneSnapshot: "America/New_York",
    startedAt: new Date("2026-11-01T03:30:00.000Z"), // Oct 31, 23:30 EDT
    endedAt: new Date("2026-11-02T05:30:00.000Z"), // Nov 2, 00:30 EST
  },
  "America/New_York",
);
assert.deepEqual(
  fallBackSlices.map((slice) => [slice.workDate, slice.durationSeconds]),
  [
    ["2026-10-31", 30 * 60],
    ["2026-11-01", 25 * 60 * 60],
    ["2026-11-02", 30 * 60],
  ],
  "fall-back day preserves its 25-hour elapsed interval",
);

console.log("Technician timesheet aggregate checks passed");