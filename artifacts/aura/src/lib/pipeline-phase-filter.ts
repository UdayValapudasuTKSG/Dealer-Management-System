export const PIPELINE_STAGES = [
  "call_centre",
  "transferred",
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
  call_centre: "Call Centre",
  transferred: "Transferred to Sales Advisor",
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
  call_centre: "call_centre",
  "call-centre": "call_centre",
  callcentre: "call_centre",
  call_center: "call_centre",
  "call-center": "call_centre",
  transferred: "transferred",
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
/**
 * Call-centre overlay: while the canonical lead phase is still new/contacted,
 * a call-centre status decides the displayed column. Once sales moves the
 * lead to qualified or beyond, the ordinary stage takes over.
 */
export function callCentreStage(lead: {
  phase: string;
  callCentreStatus?: string | null;
}): "call_centre" | "transferred" | null {
  if (lead.phase !== "new" && lead.phase !== "contacted") return null;
  const s = lead.callCentreStatus;
  if (s === "pending" || s === "follow_up") return "call_centre";
  if (s === "transferred") return "transferred";
  return null;
}

/** Case/spelling tolerant check for the Call Centre / Center Representative role. */
export function isCallCentreRole(roleName: string | null | undefined): boolean {
  if (!roleName) return false;
  const n = roleName.toLowerCase().replace(/[^a-z]/g, "");
  return n === "callcentrerepresentative" || n === "callcenterrepresentative";
}
