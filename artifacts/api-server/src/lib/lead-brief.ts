import type { Lead, Deal, Vehicle } from "@workspace/db";
import {
  ADVANCE_TARGET_PHASE,
  CHECK_OWNER,
  REVIEW_STAGE_LABEL,
  buildStageChecks,
  nextAdvanceStage,
  type AdvanceStage,
} from "./stage-review";
import { getActiveChecklist } from "./stage-checklists";
import type { ChecklistStage } from "@workspace/db";

// ---------------------------------------------------------------------------
// Deterministic lead brief — the "AURA Recommends" panel.
//
// The actions and risk level are COMPUTED from the exact same per-dealer stage
// checklist + built-in checks that gate POST /leads/{id}/advance, so a
// recommendation can never contradict what the pipeline actually requires.
// The LLM is only allowed to phrase the headline and the customer-facing
// draft message; if it fails or drifts, deterministic fallbacks are used.
// ---------------------------------------------------------------------------

export const FIRST_CONTACT_SLA_HOURS = 24;
const STALL_MEDIUM_DAYS = 7;
const STALL_HIGH_DAYS = 14;

export type BriefAction = {
  title: string;
  detail: string;
  priority: "high" | "medium" | "low";
  leadName: null;
};

export type DeterministicBrief = {
  riskLevel: "low" | "medium" | "high";
  riskReasons: string[];
  stageGoal: string;
  actions: BriefAction[];
  fallbackHeadline: string;
  fallbackDraft: string;
};

// Human phrasing for every built-in checklist key, in "do this next" form.
const CHECK_ACTION: Record<string, { title: string; detail: string }> = {
  contact_details: {
    title: "Capture Contact Details",
    detail:
      "Record an email address or phone number — qualification cannot proceed without a way to reach the customer.",
  },
  vehicle_selected: {
    title: "Record the Vehicle of Interest",
    detail:
      "Capture the model the customer is considering so the quotation and test drive can be tailored to it.",
  },
  budget_discussed: {
    title: "Capture Budget Range and Financing Preference",
    detail:
      "Ask whether the customer is purchasing outright or exploring financing, and confirm their budget ceiling.",
  },
  test_drive_booked: {
    title: "Book the Test Drive",
    detail:
      "Schedule a test-drive slot — it is the strongest conversion lever at this stage.",
  },
  licence_on_file: {
    title: "Collect the Driver's Licence",
    detail:
      "The customer's licence number must be on file before the test drive can go ahead.",
  },
  waiver_signed: {
    title: "Get the Test-Drive Waiver Signed",
    detail: "The signed waiver is required before handing over the keys.",
  },
  vehicle_available: {
    title: "Confirm Vehicle Availability",
    detail:
      "The interested vehicle is not currently available — verify inventory or guide the customer to an alternative.",
  },
  test_drive_completed: {
    title: "Complete the Test Drive",
    detail:
      "Run (or explicitly book) the test drive and log the outcome before moving to proposal.",
  },
  quote_sent: {
    title: "Send the Quotation",
    detail:
      "Prepare and send the formal quotation so the customer has concrete numbers to respond to.",
  },
  deal_created: {
    title: "Desk the Draft Deal",
    detail:
      "Enter draft deal numbers (or let AURA auto-desk on advance) so negotiation has a working sheet.",
  },
  deal_exists: {
    title: "Create the Deal",
    detail: "A deal must exist before the lead can be marked sold.",
  },
  deposit_taken: {
    title: "Collect the Deposit / Reservation Fee",
    detail:
      "Take the deposit or reservation fee — it locks the unit and confirms commitment.",
  },
  finance_approved: {
    title: "Qualify the Financing",
    detail:
      "Get finance approved or verify the cash purchase before booking can be confirmed.",
  },
};

const STAGE_GOAL: Record<AdvanceStage, string> = {
  qualified: "qualify the customer and confirm their vehicle of interest",
  test_drive: "get the customer behind the wheel",
  proposal: "put a concrete quotation in the customer's hands",
  negotiation: "align on the offer and open the deal sheet",
  sold: "secure the deposit and confirm the booking",
};

// Most-advanced-first, then newest — deterministic regardless of DB order.
const DEAL_STAGE_RANK: Record<string, number> = {
  delivered: 0,
  committed: 1,
  desking: 2,
};
export function pickPrimaryDeal(leadDeals: Deal[]): Deal | undefined {
  return [...leadDeals].sort((a, b) => {
    const ra = DEAL_STAGE_RANK[a.stage] ?? 3;
    const rb = DEAL_STAGE_RANK[b.stage] ?? 3;
    if (ra !== rb) return ra - rb;
    return (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0);
  })[0];
}

function hoursSince(d: Date | null | undefined): number | null {
  if (!d) return null;
  return (Date.now() - d.getTime()) / 36e5;
}

function daysSince(d: Date | null | undefined): number | null {
  const h = hoursSince(d);
  return h === null ? null : h / 24;
}

/**
 * Compute the deterministic brief. `lastActivityAt` is the newest timeline
 * event timestamp (or null when the lead has no recorded activity).
 */
export async function computeLeadBrief(
  lead: Lead,
  dealerId: number,
  leadDeals: Deal[],
  vehicle: Vehicle | undefined,
  lastActivityAt: Date | null,
  salesAgentEnabled: boolean,
): Promise<DeterministicBrief> {
  const actions: BriefAction[] = [];
  const riskReasons: string[] = [];
  const firstName = lead.name.split(/\s+/)[0] ?? lead.name;
  const vehicleLabel = vehicle
    ? `${vehicle.year} ${vehicle.make} ${vehicle.model}`
    : (lead.selectedModel ?? null);

  // ---- Terminal phases get their own playbooks -------------------------
  if (lead.phase === "lost") {
    return {
      riskLevel: "low",
      riskReasons: ["The lead is closed as lost — no active revenue at risk."],
      stageGoal: "understand the loss and plan re-engagement",
      actions: [
        {
          title: "Log the Loss Reason",
          detail:
            "Record why the opportunity was lost so the pattern is visible in reports.",
          priority: "medium",
          leadName: null,
        },
        {
          title: "Schedule a Re-Engagement Touch",
          detail:
            "Plan a check-in in 60–90 days — lost automotive leads frequently re-enter the market.",
          priority: "low",
          leadName: null,
        },
      ],
      fallbackHeadline: `${lead.name} is closed as lost — capture the reason and set a re-engagement reminder.`,
      fallbackDraft: `Dear ${firstName}, thank you for considering us. Should your plans change, we would be delighted to welcome you back for a fresh look at the range. Warm regards.`,
    };
  }

  const primaryDeal = pickPrimaryDeal(leadDeals);
  if (lead.phase === "won") {
    const delivered = Boolean(primaryDeal && primaryDeal.stage === "delivered");
    const committed = Boolean(
      primaryDeal &&
        (primaryDeal.stage === "committed" || primaryDeal.stage === "delivered"),
    );
    if (!primaryDeal) {
      actions.push({
        title: "Create the Deal Record",
        detail:
          "This lead is marked won but has no deal — desk the deal so delivery can be tracked.",
        priority: "high",
        leadName: null,
      });
      riskReasons.push("Won without a linked deal — delivery cannot be tracked.");
    } else if (!committed) {
      actions.push({
        title: "Settle the Payment",
        detail:
          "Move the deal to committed once payment clears — delivery is blocked until then.",
        priority: "high",
        leadName: null,
      });
    } else if (!delivered) {
      actions.push({
        title: "Run the Delivery Workflow",
        detail:
          "Payment is settled — complete the 9-step delivery workflow and hand the vehicle over.",
        priority: "high",
        leadName: null,
      });
    } else {
      actions.push({
        title: "Collect Delivery Feedback",
        detail:
          "The vehicle is delivered — capture feedback and open the ownership relationship.",
        priority: "low",
        leadName: null,
      });
    }
    const risk: "low" | "medium" = !primaryDeal ? "medium" : "low";
    return {
      riskLevel: risk,
      riskReasons: riskReasons.length
        ? riskReasons
        : ["The sale is won — remaining work is fulfilment, not conversion."],
      stageGoal: "allocate the unit, clear payment, and deliver flawlessly",
      actions,
      fallbackHeadline: delivered
        ? `${lead.name} has taken delivery — close the loop with a feedback touch.`
        : `${lead.name} is won — drive the delivery workflow to handover.`,
      fallbackDraft: `Dear ${firstName}, congratulations again on your ${vehicleLabel ?? "new vehicle"}. We are preparing everything for a flawless handover and will keep you updated at every step. Warm regards.`,
    };
  }

  // ---- Active pipeline: ground actions in the REAL advance checklist ----
  const stage = nextAdvanceStage(lead);
  const stageGoal = stage
    ? STAGE_GOAL[stage]
    : "advance the relationship";

  // AUTO-DESK: advancing into Negotiation with a vehicle selected and no
  // deal makes the sales agent desk a draft deal automatically, so the
  // deal_created/deal_exists gates are effectively met on that path.
  const autoDeskWillFire =
    stage === "negotiation" &&
    leadDeals.length === 0 &&
    Boolean(lead.interestedVehicleId) &&
    salesAgentEnabled;

  const unmetKeys: string[] = [];
  if (stage) {
    const checklist = await getActiveChecklist(dealerId, stage as ChecklistStage);
    const checks = buildStageChecks(lead, dealerId, leadDeals);
    for (const item of checklist.items) {
      if (!item.enabled) continue;
      if (
        autoDeskWillFire &&
        (item.key === "deal_created" || item.key === "deal_exists")
      )
        continue;
      const check = checks[item.key];
      const met = check ? Boolean(await check()) : true;
      if (!met) unmetKeys.push(item.key);
    }
  }

  // First contact is the overriding priority on a brand-new lead.
  const contactLogged = Boolean(lead.contactedDate);
  const ageHours = hoursSince(lead.createdAt) ?? 0;
  if (lead.phase === "new" && !contactLogged) {
    const overdue = ageHours > FIRST_CONTACT_SLA_HOURS;
    actions.push({
      title: overdue
        ? "Log the First Call Immediately"
        : "Make First Contact Today",
      detail: `${lead.assignedTo ?? "The owning advisor"} must place the first call and log it. ${
        overdue
          ? `The enquiry is ${Math.floor(ageHours)}h old with zero contact recorded — the ${FIRST_CONTACT_SLA_HOURS}h contact SLA is breached and drop-off risk climbs every hour.`
          : `The enquiry arrived ${Math.floor(ageHours)}h ago — contact within the ${FIRST_CONTACT_SLA_HOURS}h SLA keeps conversion odds at their peak.`
      }`,
      priority: "high",
      leadName: null,
    });
    if (overdue) riskReasons.push(`First-contact SLA breached (${Math.floor(ageHours)}h without contact).`);
  }

  if (!lead.assignedTo) {
    actions.push({
      title: "Assign an Owner",
      detail:
        "No advisor owns this lead — assign one now so follow-ups have a single accountable owner.",
      priority: "high",
      leadName: null,
    });
    riskReasons.push("Unassigned — nobody is accountable for the next touch.");
  }

  // Checklist-driven actions, in checklist order (the true advance gates).
  for (const key of unmetKeys) {
    const a = CHECK_ACTION[key];
    if (!a) continue;
    // Skip duplicates with the first-contact special case.
    actions.push({
      title: a.title,
      detail: `${a.detail} Required to advance to ${stage ? (REVIEW_STAGE_LABEL[stage] ?? stage) : "the next stage"}.`,
      priority: "high",
      leadName: null,
    });
  }

  // Edge case: test drive booked in the past but the lead hasn't moved on.
  if (
    lead.testDriveAt &&
    lead.testDriveAt.getTime() < Date.now() &&
    (lead.phase === "contacted" || lead.phase === "qualified")
  ) {
    actions.push({
      title: "Log the Test-Drive Outcome",
      detail:
        "The booked test-drive slot has passed — record how it went and move the lead forward while the experience is fresh.",
      priority: "medium",
      leadName: null,
    });
  }

  // Edge case: everything for the next stage is already met — advance.
  if (stage && unmetKeys.length === 0) {
    actions.push({
      title: `Advance to ${REVIEW_STAGE_LABEL[stage] ?? stage}`,
      detail: autoDeskWillFire
        ? "Every readiness item is met — advance now; AURA will automatically desk a draft deal at the vehicle's listed price for you to negotiate from."
        : "Every readiness item for the next stage is already met — advance the lead now so momentum isn't lost.",
      priority: "high",
      leadName: null,
    });
  }

  // Stalled-lead detection from real recorded activity.
  const lastTouchDays = daysSince(lastActivityAt ?? lead.createdAt);
  if (lastTouchDays !== null && lastTouchDays >= STALL_MEDIUM_DAYS) {
    actions.push({
      title: "Re-Engage — the Lead Has Gone Quiet",
      detail: `No recorded activity for ${Math.floor(lastTouchDays)} days. Place a personal touch (call or WhatsApp) before the customer shops elsewhere.`,
      priority: lastTouchDays >= STALL_HIGH_DAYS ? "high" : "medium",
      leadName: null,
    });
    riskReasons.push(
      `No activity for ${Math.floor(lastTouchDays)} days${lastTouchDays >= STALL_HIGH_DAYS ? " — severely stalled" : ""}.`,
    );
  }

  // Vehicle no longer purchasable.
  if (
    vehicle &&
    !["available", "reserved"].includes(vehicle.status) &&
    !lead.reservationFeePaid
  ) {
    riskReasons.push(
      `Interested vehicle is ${vehicle.status} — the customer may lose their preferred unit.`,
    );
  }

  // ---- Deterministic risk level ----------------------------------------
  let riskLevel: "low" | "medium" | "high" = "low";
  const slaBreached = lead.phase === "new" && !contactLogged && ageHours > FIRST_CONTACT_SLA_HOURS;
  const severelyStalled = lastTouchDays !== null && lastTouchDays >= STALL_HIGH_DAYS;
  const vehicleAtRisk =
    Boolean(vehicle && !["available", "reserved"].includes(vehicle.status)) &&
    !lead.reservationFeePaid;
  const mildlyStalled = lastTouchDays !== null && lastTouchDays >= STALL_MEDIUM_DAYS;
  const lateStageNoFee =
    lead.phase === "negotiation" && !lead.reservationFeePaid && !primaryDeal?.depositPaid;

  if (slaBreached || severelyStalled || vehicleAtRisk) riskLevel = "high";
  else if (
    mildlyStalled ||
    !lead.assignedTo ||
    lateStageNoFee ||
    (lead.phase === "new" && !contactLogged)
  )
    riskLevel = "medium";
  if (riskLevel !== "low" && riskReasons.length === 0) {
    if (!lead.assignedTo) riskReasons.push("Unassigned lead.");
    else if (lateStageNoFee)
      riskReasons.push("In negotiation with no deposit or reservation fee taken.");
    else if (lead.phase === "new" && !contactLogged)
      riskReasons.push("Awaiting first contact (within SLA).");
  }
  if (riskLevel === "low" && riskReasons.length === 0)
    riskReasons.push("On track — readiness is progressing normally.");

  // Cap at 4 actions, most important first (high → medium → low, stable).
  const rank = { high: 0, medium: 1, low: 2 } as const;
  actions.sort((a, b) => rank[a.priority] - rank[b.priority]);
  const finalActions = actions.slice(0, 4);
  if (finalActions.length === 0) {
    finalActions.push({
      title: "Maintain the Relationship",
      detail:
        "Nothing is blocking this lead right now — keep a light personal cadence until the next stage opens.",
      priority: "low",
      leadName: null,
    });
  }

  const topAction = finalActions[0];
  const fallbackHeadline = `${lead.name} is in ${lead.phase.replace("_", " ")} — the next step is to ${stageGoal}; start with: ${topAction.title.toLowerCase()}.`;
  const fallbackDraft = vehicleLabel
    ? `Dear ${firstName}, thank you for your interest in the ${vehicleLabel}. ${lead.assignedTo ? `Our specialist ${lead.assignedTo} will` : "We will"} be in touch shortly to take care of the next step personally. If there is anything you need in the meantime, please don't hesitate to reach out. Warm regards.`
    : `Dear ${firstName}, thank you for your enquiry. ${lead.assignedTo ? `Our specialist ${lead.assignedTo} will` : "We will"} be in touch shortly to understand exactly what you're looking for and arrange everything around it. Warm regards.`;

  return {
    riskLevel,
    riskReasons,
    stageGoal,
    actions: finalActions,
    fallbackHeadline,
    fallbackDraft,
  };
}
