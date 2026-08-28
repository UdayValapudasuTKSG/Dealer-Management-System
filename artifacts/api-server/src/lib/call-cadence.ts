import { and, eq, inArray, ne, sql } from "drizzle-orm";
import {
  db,
  callLogsTable,
  leadsTable,
  tasksTable,
  timelineEventsTable,
  UNCONNECTED_CALL_STATUSES,
  type Lead,
  type CallLog,
} from "@workspace/db";
import {
  dealerTimezone,
  formatDealerDateTime,
  zonedDayKey,
} from "./timezone";

// ---------------------------------------------------------------------------
// Layer 2 follow-up cadence — 48h → +3d → +3d → +7d.
// Attempt 1 is the first-contact SLA call (stageEnteredAt + 48h, surfaced by
// the SLA countdown). Every UNCONNECTED outbound attempt schedules the next
// cadence task; after 4 attempts with no connect the system stops scheduling
// and suggests closing the lead with reason "no_contact".
// All mutations run in a transaction holding a lock on the lead row so
// concurrent call logs can never stack duplicate cadence tasks.
// ---------------------------------------------------------------------------

export const CADENCE_MAX_ATTEMPTS = 4;
/** Days until the next attempt, indexed by the attempt just completed (1-based). */
const NEXT_ATTEMPT_OFFSET_DAYS: Record<number, number> = { 1: 3, 2: 3, 3: 7 };

const CADENCE_TITLE_PREFIX = "Follow-up call";
/** Only system-created tasks of these kinds are ever auto-closed. */
const CADENCE_TASK_KINDS = ["cadence", "callback"] as const;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function isCadenceEligible(lead: Lead): boolean {
  // Cadence only runs while the lead is still being chased for first contact.
  return (
    lead.status !== "lost" &&
    lead.status !== "converted" &&
    (lead.phase === "new" || lead.phase === "contacted")
  );
}

function dealerDateString(d: Date, tz: string): string {
  return zonedDayKey(d, tz);
}

/** Serialize cadence mutations per lead via a lock on the lead row. */
async function lockLead(tx: Tx, lead: Lead): Promise<void> {
  await tx.execute(
    sql`SELECT id FROM leads WHERE id = ${lead.id} AND dealer_id = ${lead.dealerId} FOR UPDATE`,
  );
}

async function completeCadenceTasksTx(
  tx: Tx,
  lead: Lead,
  why: string,
): Promise<void> {
  await tx
    .update(tasksTable)
    .set({
      status: "done",
      completedAt: new Date(),
      description: why,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(tasksTable.dealerId, lead.dealerId),
        eq(tasksTable.leadId, lead.id),
        ne(tasksTable.status, "done"),
        inArray(tasksTable.kind, [...CADENCE_TASK_KINDS]),
      ),
    );
}

/** Close out any open cadence tasks (connected, closed, or advanced lead). */
export async function completeCadenceTasks(
  lead: Lead,
  why: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockLead(tx, lead);
    await completeCadenceTasksTx(tx, lead, why);
  });
}

/**
 * React to a just-logged call: on connect close the cadence; on an
 * unconnected attempt schedule the next per 24h → +3d → +3d → +7d; after
 * the 4th miss suggest closing with reason no_contact. Callback dispositions
 * schedule a task at the requested callback time instead.
 */
export async function scheduleCadenceAfterCall(
  lead: Lead,
  call: CallLog,
): Promise<void> {
  if (call.direction !== "outbound") return;
  const tz = await dealerTimezone(lead.dealerId);

  if (call.status === "completed") {
    await completeCadenceTasks(lead, "Customer reached — cadence complete.");
    return;
  }

  if (call.status === "callback" && call.callbackAt) {
    const callbackAt = call.callbackAt;
    await db.transaction(async (tx) => {
      await lockLead(tx, lead);
      await completeCadenceTasksTx(
        tx,
        lead,
        "Customer asked for a callback — superseded by the callback task.",
      );
      await tx.insert(tasksTable).values({
        dealerId: lead.dealerId,
        leadId: lead.id,
        kind: "callback",
        title: `${CADENCE_TITLE_PREFIX} — customer requested callback: ${lead.name}`,
        description: `The customer asked to be called back at ${formatDealerDateTime(callbackAt, tz)} (dealership time). Lead #${lead.id}.`,
        assigneeUserId: lead.ownerUserId ?? null,
        dueDate: dealerDateString(callbackAt, tz),
        dueAt: callbackAt,
        priority: "high",
      });
    });
    return;
  }

  if (
    !(UNCONNECTED_CALL_STATUSES as readonly string[]).includes(call.status) ||
    !isCadenceEligible(lead)
  )
    return;

  await db.transaction(async (tx) => {
    await lockLead(tx, lead);

    // Attempt number = unconnected outbound attempts so far (incl. this one).
    const misses = await tx
      .select({ id: callLogsTable.id })
      .from(callLogsTable)
      .where(
        and(
          eq(callLogsTable.dealerId, lead.dealerId),
          eq(callLogsTable.leadId, lead.id),
          eq(callLogsTable.direction, "outbound"),
          inArray(callLogsTable.status, [...UNCONNECTED_CALL_STATUSES]),
        ),
      );
    const attempt = misses.length;

    if (attempt >= CADENCE_MAX_ATTEMPTS) {
      await completeCadenceTasksTx(
        tx,
        lead,
        "Cadence exhausted after 4 attempts.",
      );
      await tx.insert(timelineEventsTable).values({
        dealerId: lead.dealerId,
        customerId: lead.customerId,
        domain: "leads",
        kind: "cadence_exhausted",
        title: "4 call attempts with no connect — consider closing",
        detail:
          "The follow-up cadence (24h → +3d → +3d → +7d) is exhausted without reaching the customer. Suggested action: close the lead with reason “No contact”.",
        actor: "AURA",
        isAgent: false,
        refType: "lead",
        refId: lead.id,
      });
      return;
    }

    const offsetDays = NEXT_ATTEMPT_OFFSET_DAYS[attempt];
    if (!offsetDays) return;
    const due = new Date(call.createdAt.getTime() + offsetDays * 86_400_000);

    // One open cadence task at a time — replace, never stack.
    await completeCadenceTasksTx(
      tx,
      lead,
      `Superseded by attempt ${attempt + 1} task.`,
    );
    await tx.insert(tasksTable).values({
      dealerId: lead.dealerId,
      leadId: lead.id,
      kind: "cadence",
      title: `${CADENCE_TITLE_PREFIX} (attempt ${attempt + 1} of ${CADENCE_MAX_ATTEMPTS}): ${lead.name}`,
      description: `No connect on attempt ${attempt}. Next cadence touch is due in ${offsetDays} days (24h → +3d → +3d → +7d).`,
      assigneeUserId: lead.ownerUserId ?? null,
      dueDate: dealerDateString(due, tz),
      dueAt: due,
      priority: attempt >= 2 ? "high" : "normal",
    });
  });
}
