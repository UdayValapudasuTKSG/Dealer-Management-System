/** Run explicitly against disposable development fixtures; never production. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { isCallCentreRole, isCallCentreSource } from "../lib/call-centre-policy";
import { ListLeadCallsResponse, RecordCallCentreDispositionBody } from "@workspace/api-zod";

if (process.env.NODE_ENV !== "development" || process.env.TEST_CALL_CENTRE_DB !== "yes" || process.env.EXTERNAL_DATABASE_URL) {
  throw new Error("Requires NODE_ENV=development TEST_CALL_CENTRE_DB=yes and no external database");
}
const url = new URL(process.env.DATABASE_URL ?? process.env.DEV_DATABASE_URL ?? "");
if (!["helium", "localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Development database host is not allowlisted");
const { db, pool, dealersTable, usersTable, rolesTable, dealerUsersTable, leadsTable, tasksTable, callLogsTable, timelineEventsTable } =
  await import("@workspace/db");
const { recordCallCentreDisposition, reassignCallCentreLead, validateFollowUpDate } = await import("../lib/call-centre");
const { recordManualCallAttempt } = await import("../lib/manual-call-attempt");
const { autoAssignLead, lockAssignmentQueue, nextRoundRobinCandidate } = await import("../lib/lead-assignment");
const { zonedDayKey } = await import("../lib/timezone");
const dealerIds: number[] = [], userIds: number[] = [], roleIds: number[] = [];
const suffix = randomUUID();
try {
  assert(isCallCentreRole("  call  CENTER representative "));
  assert(isCallCentreRole("Call Centre Representative"));
  for (const source of ["website", "whatsapp", "facebook", "instagram", "meta", "Meta Lead Ads"]) assert(isCallCentreSource(source));
  assert(!isCallCentreSource("walk_in"));
  assert.throws(() => validateFollowUpDate("2027-02-30", "2027-01-01"));
  assert.throws(() => validateFollowUpDate("2027-01-01", "2027-01-02"));

  for (const name of [`CC regression ${suffix}`, `CC isolation ${suffix}`]) {
    const [dealer] = await db.insert(dealersTable).values({ name, timezone: "America/Guyana" }).returning();
    dealerIds.push(dealer!.id);
  }
  const dealerId = dealerIds[0]!;
  // Unique whitespace variations exercise normalization without changing production-like roles.
  for (const name of [" Call Center Representative ", " Sales Advisor "]) {
    const [existing] = await db.select().from(rolesTable).where(eq(rolesTable.name, name));
    if (existing) throw new Error("Disposable test role already exists; refusing to share fixtures");
    const [role] = await db.insert(rolesTable).values({ name }).returning();
    roleIds.push(role!.id);
  }
  for (let i = 0; i < 4; i++) {
    const [user] = await db.insert(usersTable).values({ clerkId: `cc-test-${suffix}-${i}`, name: `CC Test ${i}` }).returning();
    userIds.push(user!.id);
    await db.insert(dealerUsersTable).values({ dealerId, userId: user!.id, roleId: roleIds[i < 2 ? 0 : 1]! });
  }
  const [foreignRep] = await db.insert(usersTable).values({
    clerkId: `cc-test-${suffix}-foreign`, name: "Other dealer rep",
  }).returning();
  userIds.push(foreignRep!.id);
  await db.insert(dealerUsersTable).values({
    dealerId: dealerIds[1]!, userId: foreignRep!.id, roleId: roleIds[0]!,
  });
  const rotation = await db.transaction(async (tx) => {
    await lockAssignmentQueue(tx, dealerId);
    const first = await nextRoundRobinCandidate(tx, dealerId, "call_centre");
    await tx.update(dealerUsersTable).set({ lastLeadAssignedAt: new Date() }).where(and(
      eq(dealerUsersTable.dealerId, dealerId), eq(dealerUsersTable.userId, first!.id),
    ));
    const second = await nextRoundRobinCandidate(tx, dealerId, "call_centre");
    return [first!.id, second!.id];
  });
  assert.deepEqual(rotation, userIds.slice(0, 2));
  const actor = { id: userIds[0]!, name: "CC Test 0", roleName: "Call Center Representative" };
  async function newLead() {
    const [lead] = await db.insert(leadsTable).values({
      dealerId, name: "Qualification regression", source: "website", ownerUserId: actor.id,
      assignedTo: actor.name, callCentreRepId: actor.id, callCentreStatus: "pending", callCentreAssignedAt: new Date(),
    }).returning();
    return lead!;
  }
  const missedLead = await newLead();
  const [legacyCentreTask] = await db.insert(tasksTable).values({
    dealerId, leadId: missedLead.id, kind: "manual",
    title: `Follow-up call (attempt 2 of 4): ${missedLead.name}`, status: "open",
  }).returning();
  const tomorrow = new Date(Date.now() + 86_400_000);
  const nextWeek = new Date(Date.now() + 7 * 86_400_000);
  assert(RecordCallCentreDispositionBody.safeParse({
    outcome: "busy", notes: "Line busy", followUpAt: tomorrow.toISOString(),
  }).success);
  await assert.rejects(recordCallCentreDisposition(dealerId, missedLead.id, actor,
    { outcome: "busy", notes: "Line busy" }), { status: 400 });
  await assert.rejects(recordCallCentreDisposition(dealerId, missedLead.id, actor,
    { outcome: "no_answer", notes: "No answer", followUpAt: new Date(Date.now() - 1000) }), { status: 400 });
  assert.equal((await db.select().from(callLogsTable).where(eq(callLogsTable.leadId, missedLead.id))).length, 0);
  const busyLead = await recordCallCentreDisposition(dealerId, missedLead.id, actor,
    { outcome: "busy", notes: "Line busy, no conversation", followUpAt: tomorrow });
  assert.equal(busyLead.phase, "new");
  assert.equal(busyLead.callCentreStatus, "follow_up");
  const [closedLegacy] = await db.select().from(tasksTable).where(eq(tasksTable.id, legacyCentreTask!.id));
  assert.equal(closedLegacy?.status, "done");
  const [busyTask] = await db.select().from(tasksTable).where(and(eq(tasksTable.leadId, missedLead.id), eq(tasksTable.status, "open")));
  assert.equal(busyTask?.assigneeUserId, actor.id);
  assert.equal(busyTask?.dueAt?.getTime(), tomorrow.getTime());
  const noAnswerLead = await recordCallCentreDisposition(dealerId, missedLead.id, actor,
    { outcome: "no_answer", notes: "No answer, no conversation", followUpAt: nextWeek });
  assert.equal(noAnswerLead.ownerUserId, actor.id);
  const attemptedTasks = await db.select().from(tasksTable).where(eq(tasksTable.leadId, missedLead.id));
  assert.equal(attemptedTasks.filter((t) => t.status === "open").length, 1);
  assert.equal(attemptedTasks.find((t) => t.id === busyTask?.id)?.status, "open");
  assert.equal(attemptedTasks.find((t) => t.status === "open")?.id, busyTask?.id, "follow-up rescheduled in place");
  assert.equal(attemptedTasks.find((t) => t.status === "open")?.dueAt?.getTime(), nextWeek.getTime());
  const misses = (await db.select().from(callLogsTable).where(eq(callLogsTable.leadId, missedLead.id)))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id);
  assert.deepEqual(misses.map((c) => c.status), ["busy", "no_answer"]);
  ListLeadCallsResponse.parse(misses);
  assert.deepEqual(misses.map((_, index) => index + 1), [1, 2]);
  assert(misses.every((c) => c.sentiment === null && c.transcript === null));
  const [staffReminder] = await db.insert(tasksTable).values({
    dealerId, leadId: missedLead.id, kind: "manual", title: "Staff-only review",
    createdByUserId: actor.id, status: "open",
  }).returning();
  const wrong = await recordCallCentreDisposition(dealerId, missedLead.id, actor,
    { outcome: "wrong_number", notes: "The recipient confirmed this is not the customer's number" });
  assert.equal(wrong.phase, "lost");
  assert.equal(wrong.status, "lost");
  assert.equal(wrong.closureReason, "Wrong number: The recipient confirmed this is not the customer's number");
  assert.deepEqual((await db.select().from(tasksTable).where(and(
    eq(tasksTable.leadId, missedLead.id), eq(tasksTable.status, "open"),
  ))).map((t) => t.id), [staffReminder!.id], "only the staff-created manual reminder survives");
  // A fresh history read (the same source the UI uses after reload) is sorted
  // by timestamp then id, never by transient component state.
  const reloadedHistory = (await db.select().from(callLogsTable).where(eq(callLogsTable.leadId, missedLead.id)))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id);
  assert.deepEqual(reloadedHistory.map((c) => c.status), ["busy", "no_answer", "wrong_number"]);
  assert.deepEqual(reloadedHistory.map((_, index) => index + 1), [1, 2, 3]);
  assert(reloadedHistory.every((c) => c.sentiment === null));
  await assert.rejects(recordCallCentreDisposition(dealerId, missedLead.id, actor,
    { outcome: "no_answer", notes: "Closed", followUpAt: nextWeek }), { status: 409 });
  const lead = await newLead();
  const day = zonedDayKey(new Date(Date.now() + 2 * 86400000), "America/Guyana");
  await recordCallCentreDisposition(dealerId, lead.id, actor, { outcome: "follow_up", notes: "Requested another call", followUpDate: day });
  const [task] = await db.select().from(tasksTable).where(and(eq(tasksTable.dealerId, dealerId), eq(tasksTable.leadId, lead.id)));
  assert.equal(task!.assigneeUserId, actor.id);
  assert.equal(task!.dueDate, day);
  assert.equal(task!.kind, "call_centre");
  await assert.rejects(reassignCallCentreLead(dealerId, lead.id, userIds[2]!, actor), { status: 400 });
  await assert.rejects(reassignCallCentreLead(dealerId, lead.id, foreignRep!.id, actor), { status: 400 });
  await db.delete(dealerUsersTable).where(and(
    eq(dealerUsersTable.dealerId, dealerIds[1]!), eq(dealerUsersTable.userId, foreignRep!.id),
  ));
  await assert.rejects(reassignCallCentreLead(dealerIds[1]!, lead.id, userIds[1]!, actor), { status: 404 });
  const reassigned = await reassignCallCentreLead(dealerId, lead.id, userIds[1]!, actor);
  assert.equal(reassigned.ownerUserId, userIds[1]);
  assert.equal(reassigned.callCentreRepId, userIds[1]);
  assert.equal(reassigned.assignedTo, "CC Test 1");
  assert.equal(reassigned.callCentreFollowUpDate, day);
  assert.equal(reassigned.callCentreStatus, "follow_up");
  assert(reassigned.callCentreAssignedAt && reassigned.callCentreAssignedAt >= lead.callCentreAssignedAt!);
  const [movedTask] = await db.select().from(tasksTable).where(eq(tasksTable.id, task!.id));
  assert.equal(movedTask!.assigneeUserId, userIds[1]);
  assert.equal(movedTask!.dueDate, day);
  await db.update(usersTable).set({ status: "suspended" }).where(eq(usersTable.id, userIds[0]!));
  await assert.rejects(reassignCallCentreLead(dealerId, lead.id, userIds[0]!, actor), { status: 400 });
  await db.update(usersTable).set({ status: "active" }).where(eq(usersTable.id, userIds[0]!));
  assert.equal((await reassignCallCentreLead(dealerId, lead.id, userIds[1]!, actor)).callCentreRepId, userIds[1]);
  await assert.rejects(recordCallCentreDisposition(dealerId, lead.id, actor, { outcome: "interested", notes: "Former rep" }), { status: 403 });
  await reassignCallCentreLead(dealerId, lead.id, actor.id, { name: "CC Test manager" });
  await assert.rejects(recordCallCentreDisposition(dealerIds[1]!, lead.id, actor, { outcome: "interested", notes: "Cross tenant" }), { status: 404 });
  await assert.rejects(recordCallCentreDisposition(dealerId, lead.id, { ...actor, id: userIds[1]! }, { outcome: "interested", notes: "Not owner" }), { status: 403 });
  const [call] = await db.select().from(callLogsTable).where(and(eq(callLogsTable.dealerId, dealerId), eq(callLogsTable.leadId, lead.id)));
  await assert.rejects(recordCallCentreDisposition(dealerId, lead.id, actor, { outcome: "follow_up", notes: "Duplicate", followUpDate: day, existingCallId: call!.id }), { status: 409 });
  const lead2 = await newLead();
  const transfers = await Promise.all([lead, lead2].map((l) => recordCallCentreDisposition(
    dealerId, l.id, actor, { outcome: "interested", notes: "Interested in purchasing" },
  )));
  assert.deepEqual(new Set(transfers.map((l) => l.ownerUserId)), new Set(userIds.slice(2, 4)));
  assert(transfers.every((l) => l.callCentreStatus === "transferred" && l.phase === "contacted" && l.callCentreRepId === actor.id));
  await assert.rejects(recordCallCentreDisposition(dealerId, lead.id, actor,
    { outcome: "busy", notes: "Post-transfer", followUpAt: nextWeek }), { status: 403 });
  const manualLead = await db.insert(leadsTable).values({
    dealerId, name: "Manual attempt regression", source: "walk_in",
    ownerUserId: transfers[0]!.ownerUserId, status: "assigned", phase: "contacted",
  }).returning().then(([row]) => row!);
  const staff = { id: transfers[0]!.ownerUserId, name: "Assigned advisor" };
  const [legacyManualTask] = await db.insert(tasksTable).values({
    dealerId, leadId: manualLead.id, kind: "manual",
    title: `Follow-up call — customer requested callback: ${manualLead.name}`, status: "open",
  }).returning();
  await assert.rejects(recordManualCallAttempt(dealerId, manualLead.id, staff,
    { direction: "outbound", status: "busy" }), { status: 400 });
  await assert.rejects(recordManualCallAttempt(dealerId, manualLead.id, staff,
    { direction: "outbound", status: "no_answer", callbackAt: new Date(0) }), { status: 400 });
  assert.equal((await db.select().from(callLogsTable).where(eq(callLogsTable.leadId, manualLead.id))).length, 0);
  const manualBusy = await recordManualCallAttempt(dealerId, manualLead.id, staff,
    { direction: "outbound", status: "busy", callbackAt: tomorrow });
  assert.equal(manualBusy.sentiment, null);
  assert.equal((await db.select().from(tasksTable).where(eq(tasksTable.id, legacyManualTask!.id)))[0]?.status, "done");
  const [manualTask] = await db.select().from(tasksTable).where(and(eq(tasksTable.leadId, manualLead.id), eq(tasksTable.status, "open")));
  assert.equal(manualTask?.assigneeUserId, staff.id);
  assert.equal(manualTask?.dueAt?.getTime(), tomorrow.getTime());
  await recordManualCallAttempt(dealerId, manualLead.id, staff,
    { direction: "outbound", status: "no_answer", callbackAt: nextWeek });
  const manualTasks = await db.select().from(tasksTable).where(eq(tasksTable.leadId, manualLead.id));
  assert.equal(manualTasks.filter((t) => t.status === "open").length, 1);
  assert.equal(manualTasks.find((t) => t.status === "open")?.dueAt?.getTime(), nextWeek.getTime());
  assert.equal(manualTasks.find((t) => t.status === "open")?.id, manualTask?.id, "manual follow-up rescheduled in place");
  await assert.rejects(recordManualCallAttempt(dealerIds[1]!, manualLead.id, staff,
    { direction: "outbound", status: "wrong_number", notes: "Wrong" }), { status: 404 });
  const manualWrong = await recordManualCallAttempt(dealerId, manualLead.id, staff,
    { direction: "outbound", status: "wrong_number", notes: "Recipient does not know customer" });
  assert.equal(manualWrong.sentiment, null);
  const [manualClosed] = await db.select().from(leadsTable).where(eq(leadsTable.id, manualLead.id));
  assert.equal(manualClosed?.phase, "lost");
  assert.equal(manualClosed?.status, "lost");
  assert.equal(manualClosed?.closureReason, "Wrong number: Recipient does not know customer");
  assert.equal((await db.select().from(tasksTable).where(and(eq(tasksTable.leadId, manualLead.id), eq(tasksTable.status, "open")))).length, 0);
  await assert.rejects(recordManualCallAttempt(dealerId, manualLead.id, staff,
    { direction: "outbound", status: "no_answer", callbackAt: nextWeek }), { status: 409 });
  await assert.rejects(reassignCallCentreLead(dealerId, lead.id, userIds[0]!, actor), { status: 409 });
  await assert.rejects(recordCallCentreDisposition(dealerId, lead.id, { ...actor, roleName: "General Manager" }, { outcome: "interested", notes: "Duplicate transfer" }), { status: 409 });
  const lost = await newLead();
  const closed = await recordCallCentreDisposition(dealerId, lost.id, actor, { outcome: "not_interested", notes: "No longer buying" });
  assert.equal(closed.phase, "lost");
  assert.equal(closed.callCentreStatus, "not_interested");
  await assert.rejects(reassignCallCentreLead(dealerId, lost.id, userIds[1]!, actor), { status: 409 });
  // No available advisor: the entire attempted call must roll back.
  await db.update(usersTable).set({ status: "suspended" }).where(inArray(usersTable.id, userIds.slice(2)));
  const waiting = await newLead();
  await assert.rejects(recordCallCentreDisposition(dealerId, waiting.id, actor, { outcome: "interested", notes: "Interested" }), { status: 409 });
  assert.equal((await db.select().from(callLogsTable).where(eq(callLogsTable.leadId, waiting.id))).length, 0);
  const [unchanged] = await db.select().from(leadsTable).where(eq(leadsTable.id, waiting.id));
  assert.equal(unchanged!.callCentreStatus, "pending");
  const [unowned] = await db.insert(leadsTable).values({ dealerId: dealerIds[1]!, name: "No representatives", source: "website" }).returning();
  await autoAssignLead(unowned!);
  const [queued] = await db.select().from(leadsTable).where(eq(leadsTable.id, unowned!.id));
  assert.equal(queued!.ownerUserId, null);
  assert.equal(queued!.callCentreStatus, "pending");
  console.info("Call-centre regression assertions passed");
} finally {
  if (dealerIds.length) {
    for (const table of [tasksTable, callLogsTable, timelineEventsTable, leadsTable, dealerUsersTable]) {
      await db.delete(table).where(inArray(table.dealerId, dealerIds));
    }
    await db.delete(dealersTable).where(inArray(dealersTable.id, dealerIds));
  }
  if (userIds.length) await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  if (roleIds.length) await db.delete(rolesTable).where(inArray(rolesTable.id, roleIds));
  await pool.end();
}