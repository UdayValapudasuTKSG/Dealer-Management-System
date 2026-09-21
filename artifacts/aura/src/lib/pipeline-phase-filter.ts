export const PIPELINE_STAGES = [
  "new_lead",
  "contacted",
  "engaged",
  "pre_book",
  "vehicle_allocated",
  "payment",
  "pre_delivery",
  "delivered",
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];
export type PipelinePhaseFilter = PipelineStage | "lost";

export const PIPELINE_STAGE_LABEL: Record<PipelineStage, string> = {
  new_lead: "New",
  contacted: "Contacted",
  engaged: "Engaged",
  pre_book: "Pre-Book",
  vehicle_allocated: "Vehicle Allocated",
  payment: "Payment",
  pre_delivery: "Pre-Delivery",
  delivered: "Delivered",
};

const PHASE_ALIASES: Readonly<Record<string, PipelinePhaseFilter>> = {
  new: "new_lead",
  new_lead: "new_lead",
  "new-lead": "new_lead",
  // Legacy phase:lead links now mean the first displayed stage, not the old
  // broad Lead macro (New + Contacted + Engaged).
  lead: "new_lead",
  contacted: "contacted",
  engaged: "engaged",
  prebooking: "pre_book",
  prebook: "pre_book",
  pre_book: "pre_book",
  "pre-book": "pre_book",
  pre_booking: "pre_book",
  "pre-booking": "pre_book",
  vehicle_allocated: "vehicle_allocated",
  "vehicle-allocated": "vehicle_allocated",
  payment: "payment",
  pre_delivery: "pre_delivery",
  "pre-delivery": "pre_delivery",
  delivered: "delivered",
  // Legacy phase:delivery links select the exact Delivered stage rather than
  // the old broad Delivery macro (Pre-Delivery + Delivered).
  delivery: "delivered",
  lost: "lost",
};

/** Resolve a typed or saved phase token to one exact displayed pipeline stage. */
export function parsePipelinePhase(
  value: string,
): PipelinePhaseFilter | null {
  return PHASE_ALIASES[value.trim().toLowerCase()] ?? null;
}

/** Lost rows have a null stage; every other phase filter is an exact match. */
export function matchesPipelinePhase(
  stage: PipelineStage | null,
  phase: PipelinePhaseFilter,
): boolean {
  return phase === "lost" ? stage === null : stage === phase;
}

export function pipelinePhaseLabel(phase: PipelinePhaseFilter): string {
  return phase === "lost" ? "Lost" : PIPELINE_STAGE_LABEL[phase];
}