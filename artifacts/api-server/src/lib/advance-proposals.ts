import { and, eq, gt, notInArray, sql } from "drizzle-orm";
import {
  db,
  leadsTable,
  dealsTable,
  gatesTable,
  timelineEventsTable,
  activityTable,
  agentsTable,
  type Lead,
} from "@workspace/db";
import {
  nextAdvanceStage,
  buildStageChecks,
  REVIEW_STAGE_LABEL,
  ADVANCE_TARGET_PHASE,
} from "./stage-review";
import { getActiveChecklist } from "./stage-checklists";
import type { ChecklistStage } from "@workspace/db";
import { isAgentEnabled, recordAgentRun } from "./agent-governance";
import { notifyUser } from "./email";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Pipeline-progression agent — periodically evaluates every active lead
// against its next stage-gate checklist:
//   * checklist fully met  → raises a one-click "stage_advance" approval gate
//     (surfaces in Reviews + My Day triage; approving it performs the advance)
//   * lead sitting idle    → nudges the owning advisor (max one per day)
// Deterministic plain code — no LLM. Kill-switch aware per dealer.
// ---------------------------------------------------------------------------

const AGENT_KEY = "sales";
const AGENT_ACTOR = "AURA Pipeline Agent";
const INTERVAL_MS = 5 * 60 * 1000;
const STALLED_AFTER_DAYS = 5;
const NUDGE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

async function checklistMet(lead: Lead): Promise<{
  stage: keyof typeof ADVANCE_TARGET_PHASE;
  met: string[];
} | null> {
  const stage = nextAdvanceStage(lead);
  if (!stage) return null;
  const leadDeals = await db
    .select()
    .from(dealsTable)
    .where(
      and(eq(dealsTable.dealerId, lead.dealerId), eq(dealsTable.leadId, lead.id)),
    );
  const checklist = await getActiveChecklist(
    lead.dealerId,
    stage as ChecklistStage,
  );
  const checks = buildStageChecks(lead, lead.dealerId, leadDeals);
  const met: string[] = [];
  for (const item of checklist.items) {
    if (!item.enabled) continue;
    const check = checks[item.key];
    if (!check) continue;
    if (!(await check())) return null;
    met.push(item.label);
  }
  if (met.length === 0) return null;
  return { stage, met };
}

async function proposeAdvance(lead: Lead): Promise<boolean> {
  const ready = await checklistMet(lead);
  if (!ready) return false;

  // One open proposal per lead — don't stack duplicates.
  const [pending] = await db
    .select({ id: gatesTable.id })
    .from(gatesTable)
    .where(
      and(
        eq(gatesTable.dealerId, lead.dealerId),
        eq(gatesTable.type, "stage_advance"),
        eq(gatesTable.status, "pending"),
        eq(gatesTable.refType, "lead"),
        eq(gatesTable.refId, lead.id),
      ),
    )
    .limit(1);
  if (pending) return false;

  const stageLabel = REVIEW_STAGE_LABEL[ready.stage] ?? ready.stage;
  await db.insert(gatesTable).values({
    dealerId: lead.dealerId,
    type: "stage_advance",
    status: "pending",
    priority: "normal",
    customerId: lead.customerId,
    customerName: lead.name,
    refType: "lead",
    refId: lead.id,
    title: `Advance ${lead.name} to ${stageLabel}`,
    summary: `Every checklist item for the ${stageLabel} gate is satisfied. Approve to advance the lead in one click, or dismiss to hold.`,
    recommendation: `Approve — all ${ready.met.length} criteria met, no blockers found.`,
    evidence: [
      { label: "targetStage", value: ready.stage },
      ...ready.met.map((label) => ({ label: "Met", value: label })),
    ],
  });

  await db.insert(timelineEventsTable).values({
    dealerId: lead.dealerId,
    customerId: lead.customerId,
    domain: "leads",
    kind: "advance_proposed",
    title: `Ready to advance: ${stageLabel}`,
    detail: `All checklist criteria are met (${ready.met.join("; ")}). A one-click approval was raised for review.`,
    actor: AGENT_ACTOR,
    isAgent: true,
    refType: "lead",
    refId: lead.id,
  });

  await db.insert(activityTable).values({
    dealerId: lead.dealerId,
    agentKey: AGENT_KEY,
    actor: AGENT_ACTOR,
    isAi: true,
    action: "Proposed stage advance",
    entity: lead.name,
    detail: `${stageLabel} checklist fully met — approval raised.`,
  });
  await db
    .update(agentsTable)
    .set({ tasksToday: sql`${agentsTable.tasksToday} + 1` })
    .where(
      and(eq(agentsTable.key, AGENT_KEY), eq(agentsTable.dealerId, lead.dealerId)),
    );

  if (lead.ownerUserId != null) {
    await notifyUser({
      userId: lead.ownerUserId,
      dealerId: lead.dealerId,
      type: "approval",
      title: `${lead.name} is ready to advance to ${stageLabel}`,
      body: "All stage criteria are met — approve the advance in one click.",
      link: `/lead/${lead.id}`,
    });
  }

  await recordAgentRun({
    dealerId: lead.dealerId,
    agentKey: AGENT_KEY,
    runType: "advance_proposal",
    inputSource: "leads",
    inputSummary: `Lead #${lead.id} at phase ${lead.phase}`,
    outputSummary: `Proposed advance to ${stageLabel} (${ready.met.length} criteria met)`,
    refType: "lead",
    refId: lead.id,
    mutation: true,
  });
  return true;
}

async function nudgeIfStalled(lead: Lead): Promise<boolean> {
  if (lead.ownerUserId == null || !lead.stageEnteredAt) return false;
  const idleMs = Date.now() - lead.stageEnteredAt.getTime();
  if (idleMs < STALLED_AFTER_DAYS * 24 * 60 * 60 * 1000) return false;

  // Max one nudge per 24h per lead.
  const since = new Date(Date.now() - NUDGE_COOLDOWN_MS);
  const [recent] = await db
    .select({ id: timelineEventsTable.id })
    .from(timelineEventsTable)
    .where(
      and(
        eq(timelineEventsTable.dealerId, lead.dealerId),
        eq(timelineEventsTable.kind, "stalled_nudge"),
        eq(timelineEventsTable.refType, "lead"),
        eq(timelineEventsTable.refId, lead.id),
        gt(timelineEventsTable.createdAt, since),
      ),
    )
    .limit(1);
  if (recent) return false;

  const days = Math.floor(idleMs / (24 * 60 * 60 * 1000));
  await db.insert(timelineEventsTable).values({
    dealerId: lead.dealerId,
    customerId: lead.customerId,
    domain: "leads",
    kind: "stalled_nudge",
    title: `Stalled ${days} days — advisor nudged`,
    detail: `No stage progress in ${days} days. ${lead.assignedTo ?? "The advisor"} was nudged to re-engage or update the record.`,
    actor: AGENT_ACTOR,
    isAgent: true,
    refType: "lead",
    refId: lead.id,
  });
  await notifyUser({
    userId: lead.ownerUserId,
    dealerId: lead.dealerId,
    type: "task",
    title: `${lead.name} has stalled (${days} days in stage)`,
    body: "Re-engage the customer or update the lead so the pipeline stays honest.",
    link: `/lead/${lead.id}`,
  });
  await recordAgentRun({
    dealerId: lead.dealerId,
    agentKey: AGENT_KEY,
    runType: "stalled_nudge",
    inputSource: "leads",
    inputSummary: `Lead #${lead.id} idle ${days} days at phase ${lead.phase}`,
    outputSummary: "Advisor nudged to re-engage",
    refType: "lead",
    refId: lead.id,
  });
  return true;
}

export async function runAdvanceProposalSweep(): Promise<{
  proposed: number;
  nudged: number;
}> {
  let proposed = 0;
  let nudged = 0;
  const dealers = await db
    .selectDistinct({ dealerId: leadsTable.dealerId })
    .from(leadsTable);
  for (const { dealerId } of dealers) {
    if (!(await isAgentEnabled(dealerId, AGENT_KEY))) continue;
    const active = await db
      .select()
      .from(leadsTable)
      .where(
        and(
          eq(leadsTable.dealerId, dealerId),
          notInArray(leadsTable.status, ["lost", "converted"]),
          notInArray(leadsTable.phase, ["won"]),
        ),
      );
    for (const lead of active) {
      try {
        if (await proposeAdvance(lead)) proposed++;
        else if (await nudgeIfStalled(lead)) nudged++;
      } catch (err) {
        logger.error(
          { err, leadId: lead.id },
          "Pipeline agent failed evaluating lead",
        );
      }
    }
  }
  return { proposed, nudged };
}

let timer: NodeJS.Timeout | null = null;

/** Start the periodic pipeline-progression sweep (idempotent). */
export function startAdvanceProposalWorker(): void {
  if (timer) return;
  const tick = () =>
    void runAdvanceProposalSweep()
      .then(({ proposed, nudged }) => {
        if (proposed || nudged)
          logger.info({ proposed, nudged }, "Pipeline agent sweep done");
      })
      .catch((err) => logger.error({ err }, "Pipeline agent sweep failed"));
  setTimeout(tick, 15_000);
  timer = setInterval(tick, INTERVAL_MS);
  timer.unref?.();
}
