/** Run explicitly against disposable development fixtures; never production. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { isCallCentreRole, isCallCentreSource } from "../lib/call-centre-policy";

if (process.env.NODE_ENV !== "development" || process.env.TEST_CALL_CENTRE_DB !== "yes" || process.env.EXTERNAL_DATABASE_URL) {
  throw new Error("Requires NODE_ENV=development TEST_CALL_CENTRE_DB=yes and no external database");
}
const url = new URL(process.env.DATABASE_URL ?? process.env.DEV_DATABASE_URL ?? "");
if (!["helium", "localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Development database host is not allowlisted");
const { db, pool, dealersTable, usersTable, rolesTable, dealerUsersTable, leadsTable, tasksTable, callLogsTable, timelineEventsTable } =
  await import("@workspace/db");
const { recordCallCentreDisposition, validateFollowUpDate } = await import("../lib/call-centre");
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
  const lead = await newLead();
  const day = zonedDayKey(new Date(Date.now() + 2 * 86400000), "America/Guyana");
  await recordCallCentreDisposition(dealerId, lead.id, actor, { outcome: "follow_up", notes: "Requested another call", followUpDate: day });
  const [task] = await db.select().from(tasksTable).where(and(eq(tasksTable.dealerId, dealerId), eq(tasksTable.leadId, lead.id)));
  assert.equal(task!.assigneeUserId, actor.id);
  assert.equal(task!.dueDate, day);
  assert.equal(task!.kind, "call_centre");
  await assert.rejects(recordCallCentreDisposition(dealerIds[1]!, lead.id, actor, { outcome: "interested", notes: "Cross tenant" }), { status: 404 });
  await assert.rejects(recordCallCentreDisposition(dealerId, lead.id, { ...actor, id: userIds[1]! }, { outcome: "interested", notes: "Not owner" }), { status: 403 });
  const [call] = await db.select().from(callLogsTable).where(and(eq(callLogsTable.dealerId, dealerId), eq(callLogsTable.leadId, lead.id)));
  await assert.rejects(recordCallCentreDisposition(dealerId, lead.id, actor, { outcome: "follow_up", notes: "Duplicate", followUpDate: day, existingCallId: call!.id }), { status: 409 });
  const lead2 = await newLead();
  const transfers = await Promise.all([lead, lead2].map((l) => recordCallCentreDisposition(
    dealerId, l.id, actor, { outcome: "interested", notes: "Interested in purchasing" },
  )));
  assert.deepEqual(new Set(transfers.map((l) => l.ownerUserId)), new Set(userIds.slice(2)));
  assert(transfers.every((l) => l.callCentreStatus === "transferred" && l.phase === "contacted" && l.callCentreRepId === actor.id));
  await assert.rejects(recordCallCentreDisposition(dealerId, lead.id, { ...actor, roleName: "General Manager" }, { outcome: "interested", notes: "Duplicate transfer" }), { status: 409 });
  const lost = await newLead();
  const closed = await recordCallCentreDisposition(dealerId, lost.id, actor, { outcome: "not_interested", notes: "No longer buying" });
  assert.equal(closed.phase, "lost");
  assert.equal(closed.callCentreStatus, "not_interested");
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