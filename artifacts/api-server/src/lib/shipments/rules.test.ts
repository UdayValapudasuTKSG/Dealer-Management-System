import { test } from "node:test";
import assert from "node:assert/strict";
test("ETA window follows dealership month, rejects overdue months and malformed values", () => {
  const now = new Date("2026-11-01T02:00:00Z");
  assert.equal(etaChangeWithinWindow("2026-10", now, "America/Guyana"), true);
  assert.equal(etaChangeWithinWindow("2026-12", now, "America/Guyana"), false);
  assert.equal(etaChangeWithinWindow("2026-12", now, "Asia/Kolkata"), true);
  assert.equal(etaChangeWithinWindow("2026-09", now, "America/Guyana"), false);
  assert.equal(etaChangeWithinWindow("", now), false);
});
import {
  allocateCapacity,
  etaChangeWithinWindow,
  evaluateLease,
  planGroupMatches,
  specKey,
  validateImportRows,
  normaliseSpecText,
  type ImportContext,
} from "./rules";

function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}
const d = (iso: string) => new Date(iso);

test("capacity consumed fully or refused without partial consent", () => {
  assert.deepEqual(allocateCapacity(5, 2, 3, false), { ok: true, quantity: 3, partial: false });
  const r = allocateCapacity(5, 3, 3, false);
  assert.equal(r.ok, false);
  assert.deepEqual(allocateCapacity(5, 3, 3, true), { ok: true, quantity: 2, partial: true });
  assert.equal(allocateCapacity(5, 5, 1, true).ok, false);
  assert.equal(allocateCapacity(5, 0, 0, false).ok, false);
});

test("ETA window: current or next calendar month only", () => {
  const now = d("2026-10-20T12:00:00Z");
  assert.equal(etaChangeWithinWindow("2026-10", now), true);
  assert.equal(etaChangeWithinWindow("2026-11", now), true);
  assert.equal(etaChangeWithinWindow("2026-12", now), false);
  assert.equal(etaChangeWithinWindow("2027-01", d("2026-12-31T00:00:00Z")), true);
});

test("lease evaluation honours expiry and holder", () => {
  const now = d("2026-10-20T12:00:00Z");
  assert.equal(evaluateLease(null, 1, now), "free");
  assert.equal(evaluateLease({ holderUserId: 1, expiresAt: d("2026-10-20T12:01:00Z") }, 1, now), "mine");
  assert.equal(evaluateLease({ holderUserId: 2, expiresAt: d("2026-10-20T12:01:00Z") }, 1, now), "other");
  assert.equal(evaluateLease({ holderUserId: 2, expiresAt: d("2026-10-20T11:59:00Z") }, 1, now), "free");
});

test("matching: oldest first, younger cannot bypass older multi-unit shortage", () => {
  const plan = planGroupMatches(
    [11, 12],
    [
      { allocationId: 2, baselineAt: d("2026-02-01"), remaining: 1, partialConsent: false },
      { allocationId: 1, baselineAt: d("2026-01-01"), remaining: 3, partialConsent: false },
    ],
    seeded(7),
  );
  assert.equal(plan.assignments.length, 0);
  assert.deepEqual(plan.shortages.map((s) => [s.allocationId, s.unitsShort]), [[1, 3], [2, 1]]);
  assert.deepEqual(plan.unmatchedManifestIds.sort(), [11, 12]);
});

test("matching: serves in priority order and reports remaining VINs", () => {
  const plan = planGroupMatches(
    [1, 2, 3, 4],
    [
      { allocationId: 5, baselineAt: d("2026-01-01"), remaining: 2, partialConsent: false },
      { allocationId: 6, baselineAt: d("2026-01-02"), remaining: 1, partialConsent: false },
    ],
    seeded(3),
  );
  assert.equal(plan.assignments.filter((a) => a.allocationId === 5).length, 2);
  assert.equal(plan.assignments.filter((a) => a.allocationId === 6).length, 1);
  assert.equal(plan.unmatchedManifestIds.length, 1);
  const used = new Set(plan.assignments.map((a) => a.manifestId));
  assert.equal(used.size, 3);
});

test("matching: VIN identity is randomised, entitlement is not", () => {
  const firsts = new Set<number>();
  for (let seed = 1; seed < 40; seed += 1) {
    const plan = planGroupMatches(
      [1, 2, 3, 4, 5],
      [{ allocationId: 9, baselineAt: d("2026-01-01"), remaining: 1, partialConsent: false }],
      seeded(seed),
    );
    assert.equal(plan.assignments[0]!.allocationId, 9);
    firsts.add(plan.assignments[0]!.manifestId);
  }
  assert.ok(firsts.size > 1);
});

test("matching: partial consent takes what exists then blocks younger", () => {
  const plan = planGroupMatches(
    [1],
    [
      { allocationId: 1, baselineAt: d("2026-01-01"), remaining: 2, partialConsent: true },
      { allocationId: 2, baselineAt: d("2026-01-05"), remaining: 1, partialConsent: false },
    ],
    seeded(1),
  );
  assert.deepEqual(plan.assignments, [{ allocationId: 1, manifestId: 1 }]);
  assert.equal(plan.shortages.length, 2);
});

test("spec key: N/A explicit, case-insensitive exact", () => {
  assert.equal(normaliseSpecText(" n/a "), "N/A");
  const a = specKey({ make: "Toyota", model: "Hilux", year: 2026, variant: "GR", exteriorColor: "White", interiorColor: "N/A" });
  const b = specKey({ make: "toyota ", model: "HILUX", year: 2026, variant: "gr", exteriorColor: "white", interiorColor: "na" });
  assert.equal(a, b);
});

function ctx(kind: "lines" | "manifest"): ImportContext {
  const key = specKey({ make: "Toyota", model: "Hilux", year: 2026, variant: "GR", exteriorColor: "White", interiorColor: "N/A" });
  return {
    kind,
    approvedSpecs: new Map([[key, 10]]),
    otherSpecs: new Map(),
    existingLineSpecIds: new Set(kind === "lines" ? [] : [10]),
    lineQuantity: new Map([[10, 2]]),
    manifestCount: new Map([[10, 1]]),
    existingVins: new Set(["JTDKB20U093000001"]),
  };
}
const base = { make: "Toyota", model: "Hilux", year: "2026", variant: "GR", exteriorColor: "White", interiorColor: "N/A" };

test("partial import: valid rows accepted, blanks and dupes isolated", () => {
  const res = validateImportRows(
    [
      { rowNumber: 2, ...base, quantity: "3" },
      { rowNumber: 3, ...base, quantity: "1" },
      { rowNumber: 4, ...base, interiorColor: "", quantity: "1" },
      { rowNumber: 5, ...base, quantity: "0" },
    ],
    ctx("lines"),
  );
  assert.deepEqual(res.map((r) => r.ok), [true, false, false, false]);
  assert.match(res[2]!.message, /blank/);
});

test("manifest import: VIN format, file dupes, existing VINs, line capacity", () => {
  const res = validateImportRows(
    [
      { rowNumber: 2, ...base, vin: "JTDKB20U093000002" },
      { rowNumber: 3, ...base, vin: "JTDKB20U093000002" },
      { rowNumber: 4, ...base, vin: "JTDKB20U093000001" },
      { rowNumber: 5, ...base, vin: "JTDKB20U09300000O" },
      { rowNumber: 6, ...base, vin: "JTDKB20U093000003" },
    ],
    ctx("manifest"),
  );
  assert.deepEqual(res.map((r) => r.ok), [true, false, false, false, false]);
  assert.match(res[4]!.message, /Exceeds line quantity/);
});
