import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  db, leadsTable, callLogsTable, tasksTable, dealerUsersTable, timelineEventsTable,
  emailLogsTable, usersTable, rolesTable, type Lead,
} from "@workspace/db";
import { isActiveCallCentreLead, isCallCentreRole } from "./call-centre-policy";
import { lockAssignmentQueue, nextRoundRobinCandidate } from "./lead-assignment";
import { dealerTimezone, zonedDayKey, zonedStartOfDay } from "./timezone";

export class CallCentreError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export type CallCentreDisposition = {
  outcome: "interested" | "follow_up" | "not_interested";
  notes: string;
  durationSeconds?: number;
  followUpDate?: string;
  existingCallId?: number;
};

export function validateFollowUpDate(value: string | undefined, today: string): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value || value < today) {
    throw new CallCentreError(400, "Choose a valid follow-up date today or later in the dealership timezone");
  }
  return value;
}

/** Manual queue reassignment; never changes the lead's qualification state or follow-up date. */
export async function reassignCallCentreLead(
  dealerId: number,
  leadId: number,
  userId: number,
  actor: { name: string | null },
): Promise<Lead> {
  return db.transaction(async (tx) => {
    await lockAssignmentQueue(tx, dealerId);
    const [lead] = await tx.select().from(leadsTable).where(and(
      eq(leadsTable.id, leadId), eq(leadsTable.dealerId, dealerId), isNull(leadsTable.deletedAt),
    )).for("update");
    if (!lead) throw new CallCentreError(404, "Lead not found");
    if (!isActiveCallCentreLead(lead) || lead.callCentreTransferredAt ||
        !["new", "contacted"].includes(lead.phase) || ["lost", "converted"].includes(lead.status)) {
      throw new CallCentreError(409, "This lead is no longer awaiting call-centre qualification");
    }
    const [rep] = await tx.select({ id: usersTable.id, name: usersTable.name, email: usersTable.email, role: rolesTable.name })
      .from(dealerUsersTable)
      .innerJoin(usersTable, eq(usersTable.id, dealerUsersTable.userId))
      .innerJoin(rolesTable, eq(rolesTable.id, dealerUsersTable.roleId))
      .where(and(eq(dealerUsersTable.dealerId, dealerId), eq(dealerUsersTable.userId, userId),
        eq(usersTable.status, "active")));
    if (!rep || !isCallCentreRole(rep.role)) {
      throw new CallCentreError(400, "Select an active Call Center or Centre Representative in this dealership");
    }
    if (lead.ownerUserId === rep.id && lead.callCentreRepId === rep.id) {
      return lead;
    }
    const now = new Date();
    const name = rep.name ?? rep.email ?? `User #${rep.id}`;
    const [updated] = await tx.update(leadsTable).set({
      ownerUserId: rep.id, assignedTo: name, callCentreRepId: rep.id,
      callCentreAssignedAt: now,
      status: lead.status === "new" ? "assigned" : lead.status,
    }).where(and(eq(leadsTable.id, leadId), eq(leadsTable.dealerId, dealerId))).returning();
    await tx.update(dealerUsersTable).set({ lastLeadAssignedAt: now }).where(and(
      eq(dealerUsersTable.dealerId, dealerId), eq(dealerUsersTable.userId, rep.id),
    ));
    await tx.update(tasksTable).set({ assigneeUserId: rep.id, updatedAt: now }).where(and(
      eq(tasksTable.dealerId, dealerId), eq(tasksTable.leadId, leadId),
      inArray(tasksTable.kind, ["call_centre", "callback", "cadence"]),
      inArray(tasksTable.status, ["open", "in_progress"]),
    ));
    await tx.insert(timelineEventsTable).values({
      dealerId, customerId: lead.customerId, domain: "leads", kind: "advisor_assigned",
      title: `Call centre reassigned to ${name}`,
      detail: `${actor.name ?? "Staff"} reassigned the call-centre lead from ${lead.assignedTo ?? "Unassigned"} to ${name}.`,
      actor: actor.name ?? "Staff", isAgent: false, refType: "lead", refId: leadId,
    });
    return updated!;
  });
}

/** Call, ownership, follow-up task, timeline and queue clock commit together. */
export async function recordCallCentreDisposition(
  dealerId: number,
  leadId: number,
  actor: { id: number; name: string | null; roleName: string | null; isSuperAdmin?: boolean },
  input: CallCentreDisposition,
): Promise<Lead> {
  const timezone = await dealerTimezone(dealerId);
  const now = new Date();
  const followUpDate = input.outcome === "follow_up"
    ? validateFollowUpDate(input.followUpDate, zonedDayKey(now, timezone)) : null;
  if (!input.notes.trim()) throw new CallCentreError(400, "Call notes are required");
  return db.transaction(async (tx) => {
    // Queue lock always precedes row lock, matching intake and avoiding deadlocks.
    await lockAssignmentQueue(tx, dealerId);
    const [lead] = await tx.select().from(leadsTable)
      .where(and(eq(leadsTable.id, leadId), eq(leadsTable.dealerId, dealerId), isNull(leadsTable.deletedAt)))
      .for("update");
    if (!lead) throw new CallCentreError(404, "Lead not found");
    const manager = actor.isSuperAdmin ||
      ["general manager", "sales manager"].includes((actor.roleName ?? "").trim().toLowerCase());
    if (!manager && !(isCallCentreRole(actor.roleName) && lead.ownerUserId === actor.id &&
      lead.callCentreRepId === actor.id)) {
      throw new CallCentreError(403, "Only the assigned call-centre representative or a manager can record this outcome");
    }
    if (!isActiveCallCentreLead(lead) || lead.callCentreTransferredAt ||
        !["new", "contacted"].includes(lead.phase) || ["lost", "converted"].includes(lead.status)) {
      throw new CallCentreError(409, "This lead is no longer awaiting call-centre qualification");
    }
    if (!lead.callCentreRepId || lead.ownerUserId !== lead.callCentreRepId) {
      throw new CallCentreError(409, "Assign this lead to a call-centre representative before recording a call");
    }
    const advisor = input.outcome === "interested" ? await nextRoundRobinCandidate(tx, dealerId, "sales") : null;
    if (input.outcome === "interested" && !advisor) {
      throw new CallCentreError(409, "No active Sales Advisor is available. The call and lead have not been changed.");
    }
    let callId = input.existingCallId;
    const callValues = {
      status: input.outcome === "follow_up" ? "callback" : "completed",
      notes: input.notes.trim(),
      sentiment: input.outcome === "interested" ? "positive" : input.outcome === "not_interested" ? "negative" : "neutral",
      callbackAt: followUpDate ? zonedStartOfDay(followUpDate, timezone) : null,
    };
    if (callId) {
      const [call] = await tx.select().from(callLogsTable).where(and(
        eq(callLogsTable.id, callId), eq(callLogsTable.dealerId, dealerId), eq(callLogsTable.leadId, leadId),
      )).for("update");
      if (!call) throw new CallCentreError(404, "Call not found");
      if (call.status === "in_progress") throw new CallCentreError(409, "Finish the call before recording qualification");
      const [prior] = await tx.select({ id: timelineEventsTable.id }).from(timelineEventsTable).where(and(
        eq(timelineEventsTable.dealerId, dealerId), eq(timelineEventsTable.refId, leadId),
        eq(timelineEventsTable.refType, "lead"), eq(timelineEventsTable.cause, `call_centre:${callId}`),
      )).limit(1);
      if (prior) throw new CallCentreError(409, "This call already has a qualification outcome");
      await tx.update(callLogsTable).set(callValues).where(and(eq(callLogsTable.id, callId), eq(callLogsTable.dealerId, dealerId)));
    } else {
      const [call] = await tx.insert(callLogsTable).values({
        dealerId, leadId, direction: "outbound", provider: "manual",
        actor: actor.name ?? "Staff", durationSeconds: input.durationSeconds ?? null, ...callValues,
      }).returning();
      callId = call!.id;
    }

    // Resolve earlier system reminders; a follow-up outcome replaces the date.
    await tx.update(tasksTable).set({ status: "done", completedAt: now, updatedAt: now }).where(and(
      eq(tasksTable.dealerId, dealerId), eq(tasksTable.leadId, leadId),
      inArray(tasksTable.kind, ["call_centre", "callback", "cadence"]),
      inArray(tasksTable.status, ["open", "in_progress"]),
    ));
    if (followUpDate) {
      await tx.insert(tasksTable).values({
        dealerId, leadId, title: `Call centre follow-up: ${lead.name}`,
        description: input.notes.trim(), assigneeUserId: lead.callCentreRepId,
        createdByUserId: actor.id, dueDate: followUpDate,
        // Date-only commitment: the existing sweep interprets dueDate in dealer timezone.
        kind: "call_centre", priority: "normal", status: "open",
      });
    }
    const [updated] = await tx.update(leadsTable).set({
      callCentreStatus: input.outcome === "interested" ? "transferred" : input.outcome,
      callCentreFollowUpDate: followUpDate,
      contactedDate: lead.contactedDate ?? now,
      phase: input.outcome === "not_interested" ? "lost" : "contacted",
      status: input.outcome === "not_interested" ? "lost" : input.outcome === "interested" ? "assigned" : "contacted",
      stageEnteredAt: now,
      ...(advisor ? { ownerUserId: advisor.id, assignedTo: advisor.name ?? advisor.email ?? `User #${advisor.id}`,
        callCentreTransferredAt: now } : {}),
      ...(input.outcome === "not_interested" ? { closureReason: input.notes.trim() } : {}),
    }).where(and(eq(leadsTable.id, leadId), eq(leadsTable.dealerId, dealerId))).returning();
    if (advisor) {
      await tx.update(dealerUsersTable).set({ lastLeadAssignedAt: now })
        .where(and(eq(dealerUsersTable.dealerId, dealerId), eq(dealerUsersTable.userId, advisor.id)));
    }
    if (input.outcome === "not_interested") {
      await tx.update(emailLogsTable).set({ status: "cancelled" }).where(and(
        eq(emailLogsTable.dealerId, dealerId), eq(emailLogsTable.leadId, leadId), eq(emailLogsTable.status, "queued"),
      ));
    }
    await tx.insert(timelineEventsTable).values({
      dealerId, customerId: lead.customerId, domain: "leads", kind: "call_centre_disposition",
      title: advisor ? "Transferred to Sales Advisor" : followUpDate ? "Call centre follow-up scheduled" : "Call centre — not interested",
      detail: `${input.notes.trim()}${advisor ? `\nRound robin: ${updated!.assignedTo}` : followUpDate ? `\nFollow-up: ${followUpDate}` : ""}`,
      actor: actor.name ?? "Staff", isAgent: false, refType: "lead", refId: leadId, cause: `call_centre:${callId}`,
    });
    return updated!;
  });
}