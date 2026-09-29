import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import {
  db, leadsTable, callLogsTable, tasksTable, dealerUsersTable, timelineEventsTable,
  emailLogsTable, usersTable, rolesTable, type Lead,
} from "@workspace/db";
import { isActiveCallCentreLead, isCallCentreRole } from "./call-centre-policy";
import { lockAssignmentQueue, nextRoundRobinCandidate } from "./lead-assignment";
import { dealerTimezone, zonedDayKey, zonedStartOfDay, formatDealerDateTime } from "./timezone";
import { pendingCallSystemTasks } from "./call-cadence";

export class CallCentreError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export type CallCentreDisposition = {
  outcome: "interested" | "follow_up" | "not_interested" | "busy" | "no_answer" | "wrong_number";
  notes: string;
  durationSeconds?: number;
  followUpDate?: string;
  followUpAt?: string | Date;
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
  const missed = input.outcome === "busy" || input.outcome === "no_answer";
  const followUpAt = missed && input.followUpAt ? new Date(input.followUpAt) : null;
  if (missed && (!followUpAt || !Number.isFinite(followUpAt.getTime()) || followUpAt <= now)) {
    throw new CallCentreError(400, "Busy and no-answer calls require a future follow-up date and time");
  }
  if (input.outcome === "wrong_number" && input.notes.trim().length < 3) {
    throw new CallCentreError(400, "Explain why this number is wrong");
  }
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
      status: missed || input.outcome === "wrong_number" ? input.outcome : input.outcome === "follow_up" ? "callback" : "completed",
      notes: input.notes.trim(),
      sentiment: missed || input.outcome === "wrong_number" ? null : input.outcome === "interested" ? "positive" : input.outcome === "not_interested" ? "negative" : "neutral",
      callbackAt: followUpAt ?? (followUpDate ? zonedStartOfDay(followUpDate, timezone) : null),
    };
    if (callId) {
      const [call] = await tx.select().from(callLogsTable).where(and(
        eq(callLogsTable.id, callId), eq(callLogsTable.dealerId, dealerId), eq(callLogsTable.leadId, leadId),
      )).for("update");
      if (!call) throw new CallCentreError(404, "Call not found");
      if (call.status === "in_progress") throw new CallCentreError(409, "Finish the call before recording qualification");
      if (missed && call.status === "completed") throw new CallCentreError(409, "A connected call cannot be marked busy or unanswered");
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

    // Reschedule the assigned reminder in place when possible; close any
    // duplicate or legacy system reminders, never staff-created manual tasks.
    const [reminder] = followUpDate || followUpAt ? await tx.select().from(tasksTable).where(and(
      pendingCallSystemTasks(dealerId, leadId),
      eq(tasksTable.kind, "call_centre"),
      eq(tasksTable.assigneeUserId, lead.callCentreRepId),
    )).orderBy(desc(tasksTable.id)).limit(1).for("update") : [];
    await tx.update(tasksTable).set({ status: "done", completedAt: now, updatedAt: now })
      .where(and(pendingCallSystemTasks(dealerId, leadId),
        reminder ? ne(tasksTable.id, reminder.id) : undefined));
    if (followUpDate || followUpAt) {
      const schedule = {
        title: `Call centre follow-up: ${lead.name}`,
        description: input.notes.trim(), assigneeUserId: lead.callCentreRepId,
        dueDate: followUpDate ?? zonedDayKey(followUpAt!, timezone), dueAt: followUpAt,
      };
      if (reminder) {
        await tx.update(tasksTable).set({
          ...schedule, status: "open", completedAt: null,
          dueSoonNotifiedAt: null, overdueNotifiedAt: null, updatedAt: now,
        }).where(and(eq(tasksTable.id, reminder.id), eq(tasksTable.dealerId, dealerId)));
      } else {
        await tx.insert(tasksTable).values({
          dealerId, leadId, ...schedule, createdByUserId: actor.id,
          // Date-only commitment: the sweep interprets dueDate in dealer time.
          kind: "call_centre", priority: "normal", status: "open",
        });
      }
    }
    const [updated] = await tx.update(leadsTable).set({
      callCentreStatus: input.outcome === "interested" ? "transferred" : missed ? "follow_up" : input.outcome === "wrong_number" ? "not_interested" : input.outcome,
      callCentreFollowUpDate: followUpDate ?? (followUpAt ? zonedDayKey(followUpAt, timezone) : null),
      contactedDate: missed || input.outcome === "wrong_number" ? lead.contactedDate : lead.contactedDate ?? now,
      phase: input.outcome === "not_interested" || input.outcome === "wrong_number" ? "lost" : missed ? lead.phase : "contacted",
      status: input.outcome === "not_interested" || input.outcome === "wrong_number" ? "lost" : input.outcome === "interested" ? "assigned" : missed ? lead.status : "contacted",
      stageEnteredAt: now,
      ...(advisor ? { ownerUserId: advisor.id, assignedTo: advisor.name ?? advisor.email ?? `User #${advisor.id}`,
        callCentreTransferredAt: now } : {}),
      ...(input.outcome === "not_interested" || input.outcome === "wrong_number" ? { closureReason: input.outcome === "wrong_number" ? `Wrong number: ${input.notes.trim()}` : input.notes.trim() } : {}),
    }).where(and(eq(leadsTable.id, leadId), eq(leadsTable.dealerId, dealerId))).returning();
    if (advisor) {
      await tx.update(dealerUsersTable).set({ lastLeadAssignedAt: now })
        .where(and(eq(dealerUsersTable.dealerId, dealerId), eq(dealerUsersTable.userId, advisor.id)));
    }
    if (input.outcome === "not_interested" || input.outcome === "wrong_number") {
      await tx.update(emailLogsTable).set({ status: "cancelled" }).where(and(
        eq(emailLogsTable.dealerId, dealerId), eq(emailLogsTable.leadId, leadId), eq(emailLogsTable.status, "queued"),
      ));
    }
    await tx.insert(timelineEventsTable).values({
      dealerId, customerId: lead.customerId, domain: "leads", kind: "call_centre_disposition",
       title: advisor ? "Transferred to Sales Advisor" : followUpDate || followUpAt ? `Call centre — ${input.outcome.replace("_", " ")}; follow-up scheduled` : `Call centre — ${input.outcome.replace("_", " ")}`,
       detail: `${input.notes.trim()}${advisor ? `\nRound robin: ${updated!.assignedTo}` : followUpAt ? `\nFollow-up: ${formatDealerDateTime(followUpAt, timezone)}` : followUpDate ? `\nFollow-up: ${followUpDate}` : ""}`,
      actor: actor.name ?? "Staff", isAgent: false, refType: "lead", refId: leadId, cause: `call_centre:${callId}`,
    });
    return updated!;
  });
}