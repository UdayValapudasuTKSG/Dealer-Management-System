import {
  isAgentEnabled,
  recordAgentRun,
} from "./agent-governance";
import { financeUsers, serviceUsers, usersWithPermission } from "./notify-matrix";
import { notifyInternal } from "./notify-triggers";
import { logger } from "./logger";

const AGENT_KEY = "collision_coordinator";

type CollisionAutomationEvent =
  | "created"
  | "status"
  | "supplement_submitted"
  | "supplement_decided"
  | "resumed"
  | "settlement"
  | "communication";

type CollisionAutomationInput = {
  id: number;
  dealerId: number;
  vehicleInfo: string;
  status: string;
  event: CollisionAutomationEvent;
  eventKey: string;
  detail?: string | null;
};

const pretty = (value: string) =>
  value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

function nextAction(input: CollisionAutomationInput): {
  title: string;
  body: string;
  audience: "service" | "approvers" | "finance";
} {
  if (input.event === "supplement_submitted") {
    return {
      title: "Collision supplement awaiting decision",
      body: input.detail || "Review the hidden-damage supplement and record the insurer decision.",
      audience: "approvers",
    };
  }
  if (input.event === "supplement_decided") {
    return {
      title: `Collision supplement ${input.detail || "updated"}`,
      body: "Review the revised approved scope and continue the existing repair plan.",
      audience: "service",
    };
  }
  if (input.event === "settlement") {
    return {
      title: "Collision payment recorded",
      body: input.detail || "Review the remaining insurer and customer balances.",
      audience: "finance",
    };
  }
  if (input.event === "communication") {
    return {
      title: "Collision claim email queued",
      body: input.detail || "A staff-approved claim communication is queued through dealer SMTP.",
      audience: "service",
    };
  }
  if (input.event === "resumed") {
    return {
      title: "Collision repair resumed",
      body: "Backordered parts are available. Resume the job card and workshop schedule.",
      audience: "service",
    };
  }

  const byStatus: Record<
    string,
    { title: string; body: string; audience: "service" | "approvers" | "finance" }
  > = {
    intake: {
      title: "New collision claim intake",
      body: "Review the evidence, confirm loss details and draft the initial estimate.",
      audience: "service",
    },
    estimate_drafted: {
      title: "Collision estimate ready to submit",
      body: "Check the estimate and supporting evidence before insurer submission.",
      audience: "service",
    },
    submitted: {
      title: "Collision claim submitted",
      body: "Monitor for the adjuster response and record contested or approved values.",
      audience: "service",
    },
    adjuster_review: {
      title: "Adjuster review needs attention",
      body: "Record the insurer response and approved estimate before approval.",
      audience: "approvers",
    },
    approved: {
      title: "Collision repair approved",
      body: "Order approved parts and schedule the repair through the existing job card.",
      audience: "service",
    },
    parts_ordered: {
      title: "Collision parts ordered",
      body: "Monitor availability; backorders will pause the measured claim cycle time.",
      audience: "service",
    },
    in_repair: {
      title: "Collision repair in progress",
      body: "Complete approved work and submit hidden damage as separate supplements.",
      audience: "service",
    },
    quality_check: {
      title: "Collision quality check ready",
      body: "Review the completed repair and record insurer sign-off.",
      audience: "approvers",
    },
    insurer_signoff: {
      title: "Collision claim ready to invoice",
      body: "Issue the service invoice; AURA will split insurer and deductible balances.",
      audience: "finance",
    },
    invoiced: {
      title: "Collision balances ready for collection",
      body: "Track insurer responsibility and customer deductible separately.",
      audience: "finance",
    },
    closed: {
      title: "Collision claim closed",
      body: "No further action is required. The complete audit timeline remains available.",
      audience: "service",
    },
    denied: {
      title: "Collision claim denied",
      body: "Review the recorded outcome and communicate the next step through the service team.",
      audience: "approvers",
    },
    total_loss: {
      title: "Collision claim recorded as total loss",
      body: "Review the value evidence and coordinate the non-repair outcome.",
      audience: "approvers",
    },
  };
  return byStatus[input.status] ?? {
    title: "Collision claim updated",
    body: "Open the claim to review the latest status and next step.",
    audience: "service",
  };
}

/**
 * Governed, asynchronous collision handoff automation. It creates no claim
 * decisions and never calls workflow transitions: it only routes the next
 * action through the existing in-app + email outbox channels.
 */
export function coordinateCollisionClaim(input: CollisionAutomationInput): void {
  // Focused collision acceptance runs validate the workflow and reviewed-email
  // queueing directly. Suppress asynchronous staff routing in that explicit
  // test process so it cannot race fixture cleanup or leak test notifications
  // into the shared development outbox.
  if (
    process.env.COLLISION_DRAFT_VERIFIER === "1" &&
    process.env.OUTBOX_WORKER_DISABLED === "1"
  ) {
    return;
  }
  void (async () => {
    if (!(await isAgentEnabled(input.dealerId, AGENT_KEY))) {
      await recordAgentRun({
        dealerId: input.dealerId,
        agentKey: AGENT_KEY,
        runType: input.event,
        inputSource: "collision_claim",
        inputSummary: `Claim ${input.id} changed to ${input.status}`,
        status: "blocked",
        refType: "collision_claim",
        refId: input.id,
      });
      return;
    }

    const action = nextAction(input);
    const service = await serviceUsers(input.dealerId);
    let recipients = service;
    if (action.audience === "finance") {
      const finance = await financeUsers(input.dealerId);
      recipients = finance.length ? finance : service;
    } else if (action.audience === "approvers") {
      const approvers = await usersWithPermission(input.dealerId, "service", [
        "approve",
        "admin",
      ]);
      // Explicit service view remains the master visibility requirement.
      const visible = new Set(service);
      const allowed = approvers.filter((id) => visible.has(id));
      recipients = allowed.length ? allowed : service;
    }

    await notifyInternal({
      dealerId: input.dealerId,
      userIds: recipients,
      type: "collision.claim.action",
      template: "collision.claim.action",
      title: action.title,
      body: action.body,
      link: "/service?tab=collision",
      entityType: "collision_claim",
      entityId: input.id,
      dedupeKey: `collision:claim:${input.id}:${input.eventKey}:v1`,
      data: {
        action: action.title,
        claimRef: `Claim #${input.id}`,
        vehicle: input.vehicleInfo,
        status: pretty(input.status),
        body: action.body,
        link: "/service?tab=collision",
      },
    });

    await recordAgentRun({
      dealerId: input.dealerId,
      agentKey: AGENT_KEY,
      runType: input.event,
      inputSource: "collision_claim",
      inputSummary: `Claim ${input.id} changed to ${input.status}`,
      outputSummary: `${action.title}; routed to ${recipients.length} staff`,
      status: "completed",
      refType: "collision_claim",
      refId: input.id,
      autonomy: "autonomous",
    });
  })().catch((err) => {
    logger.error({ err, claimId: input.id }, "collision coordinator failed");
  });
}