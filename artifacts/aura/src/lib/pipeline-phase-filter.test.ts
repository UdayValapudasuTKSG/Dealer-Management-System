import assert from "node:assert/strict";
import test from "node:test";
import {
  PIPELINE_STAGES,
  matchesPipelinePhase,
  parsePipelinePhase,
  pipelinePhaseLabel,
  type PipelineStage,
} from "./pipeline-phase-filter.ts";

test("prebooking resolves to Pre-Book and excludes Vehicle Allocated", () => {
  const phase = parsePipelinePhase("prebooking");
  assert.equal(phase, "pre_book");
  assert.equal(matchesPipelinePhase("pre_book", phase!), true);
  assert.equal(matchesPipelinePhase("vehicle_allocated", phase!), false);
});

test("matches every displayed stage and Lost exactly", () => {
  const stages: Array<PipelineStage | null> = [...PIPELINE_STAGES, null];
  for (const stage of stages) {
    const token = stage ?? "lost";
    const phase = parsePipelinePhase(token);
    assert.notEqual(phase, null, token);
    assert.deepEqual(
      stages.filter((candidate) => matchesPipelinePhase(candidate, phase!)),
      [stage],
      token,
    );
  }
});

test("supports exact-stage aliases, including narrow legacy saved tokens", () => {
  const aliases: Record<string, string> = {
    new: "new_lead",
    "new-lead": "new_lead",
    lead: "new_lead",
    prebooking: "pre_book",
    "pre-book": "pre_book",
    pre_book: "pre_book",
    "vehicle-allocated": "vehicle_allocated",
    vehicle_allocated: "vehicle_allocated",
    "pre-delivery": "pre_delivery",
    pre_delivery: "pre_delivery",
    delivery: "delivered",
  };
  for (const [alias, expected] of Object.entries(aliases)) {
    assert.equal(parsePipelinePhase(alias), expected, alias);
  }
});

test("labels canonicalized aliases correctly and rejects unknown values", () => {
  const phase = parsePipelinePhase("PRE-BOOKING");
  assert.equal(phase, "pre_book");
  assert.equal(pipelinePhaseLabel(phase!), "Pre-Book");
  assert.equal(parsePipelinePhase("allocated"), null);
});

test("exact phase predicate composes with other filters using AND", () => {
  const rows = [
    { stage: "pre_book" as const, source: "website", advisor: "Asha" },
    { stage: "pre_book" as const, source: "phone", advisor: "Asha" },
    { stage: "vehicle_allocated" as const, source: "website", advisor: "Asha" },
  ];
  const phase = parsePipelinePhase("prebooking")!;
  assert.deepEqual(
    rows.filter(
      (row) =>
        matchesPipelinePhase(row.stage, phase) &&
        row.source === "website" &&
        row.advisor === "Asha",
    ),
    [rows[0]],
  );
});