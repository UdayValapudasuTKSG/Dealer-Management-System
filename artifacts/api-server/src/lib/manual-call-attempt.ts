import { and, desc, eq, isNull, ne } from "drizzle-orm";
import {
  db, leadsTable, callLogsTable, tasksTable, emailLogsTable, timelineEventsTable,
  type CallLog,
} from "@workspace/db";
import { dealerTimezone, zonedDayKey } from "./timezone";
import { isActiveCallCentreLead } from "./call-centre-policy";
import { pendingCallSystemTasks } from "./call-cadence";

export class ManualCallAttemptError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Staff-confirmed failed attempt or wrong number; never called by a provider webhook. */
export async function recordManualCallAttempt(
  dealerId: number,
  leadId: number,
  actor: { id: number | null; name: string },
  input: {
    direction: "outbound" | "inbound";
    status: "busy" | "no_answer" | "wrong_number";
    callbackAt?: Date | null;
    notes?: string | null;
    durationSeconds?: number | null;
  },
): Promise<CallLog> {
  const wrong = input.status === "wrong_number";
  if (!wrong && (!input.callbackAt || !Number.isFinite(input.callbackAt.getTime()) || input.callbackAt <= new Date())) {
    throw new ManualCallAttemptError(400, "Busy and no-answer calls need a future follow-up date and time");
  }
  if (wrong && !input.notes?.trim()) {
    throw new ManualCallAttemptError(400, "Explain why the number is wrong");
  }
  const timezone = await dealerTimezone(dealerId);
  return db.transaction(async (tx) => {
    const now = new Date();
    const [lead] = await tx.select().from(leadsTable).where(and(
      eq(leadsTable.id, leadId), eq(leadsTable.dealerId, dealerId), isNull(leadsTable.deletedAt),
    )).for("update");
    if (!lead) throw new ManualCallAttemptError(404, "Lead not found");
    if (lead.phase === "lost" || lead.phase === "won" || isActiveCallCentreLead(lead)) {
      throw new ManualCallAttemptError(409, "This lead is closed or awaiting call-centre qualification");
    }
    const [call] = await tx.insert(callLogsTable).values({
      dealerId, leadId, provider: "manual", actor: actor.name,
      direction: input.direction, status: input.status, sentiment: null,
      durationSeconds: input.durationSeconds ?? null, notes: input.notes?.trim() || null,
      callbackAt: wrong ? null : input.callbackAt!,
    }).returning();
    const [reminder] = !wrong ? await tx.select().from(tasksTable).where(and(
      pendingCallSystemTasks(dealerId, leadId),
      eq(tasksTable.kind, "callback"),
      lead.ownerUserId != null ? eq(tasksTable.assigneeUserId, lead.ownerUserId) : isNull(tasksTable.assigneeUserId),
    )).orderBy(desc(tasksTable.id)).limit(1).for("update") : [];
    await tx.update(tasksTable).set({ status: "done", completedAt: now, updatedAt: now })
      .where(and(pendingCallSystemTasks(dealerId, leadId),
        reminder ? ne(tasksTable.id, reminder.id) : undefined));
    if (wrong) {
      await tx.update(leadsTable).set({
        phase: "lost", status: "lost", stageEnteredAt: now,
        closureReason: `Wrong number: ${input.notes!.trim()}`,
      }).where(and(eq(leadsTable.id, leadId), eq(leadsTable.dealerId, dealerId)));
      await tx.update(emailLogsTable).set({ status: "cancelled" }).where(and(
        eq(emailLogsTable.dealerId, dealerId), eq(emailLogsTable.leadId, leadId),
        eq(emailLogsTable.status, "queued"),
      ));
    } else {
      const schedule = {
        title: `Follow-up call: ${lead.name}`,
        description: input.notes?.trim() || `Previous attempt: ${input.status.replace("_", " ")}`,
        assigneeUserId: lead.ownerUserId, createdByUserId: actor.id,
        dueDate: zonedDayKey(input.callbackAt!, timezone), dueAt: input.callbackAt,
      };
      if (reminder) {
        await tx.update(tasksTable).set({
          ...schedule, status: "open", completedAt: null, updatedAt: now,
          dueSoonNotifiedAt: null, overdueNotifiedAt: null,
        }).where(and(eq(tasksTable.id, reminder.id), eq(tasksTable.dealerId, dealerId)));
      } else {
        await tx.insert(tasksTable).values({
          dealerId, leadId, kind: "callback", ...schedule,
          priority: "normal", status: "open",
        });
      }
    }
    await tx.insert(timelineEventsTable).values({
      dealerId, customerId: lead.customerId, domain: "leads", kind: "call",
      title: `${input.direction === "outbound" ? "Outbound" : "Inbound"} call — ${input.status.replace("_", " ")}`,
      detail: input.notes?.trim() || null, actor: actor.name, isAgent: false,
      refType: "lead", refId: leadId,
    });
    return call!;
  });
}