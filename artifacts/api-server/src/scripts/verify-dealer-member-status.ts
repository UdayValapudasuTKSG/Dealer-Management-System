import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

if (process.env.NODE_ENV === "production") throw Error("Development only");
const url = process.env.DATABASE_URL ?? process.env.DEV_DATABASE_URL;
if (!url || !["helium", "localhost", "127.0.0.1"].includes(new URL(url).hostname)) {
  throw Error("Refusing non-local database");
}
process.env.OUTBOX_WORKER_DISABLED = "1";
const { db, pool, dealersTable, usersTable, dealerUsersTable, rolesTable, auditLogsTable } = await import("@workspace/db");
const { eq, inArray } = await import("drizzle-orm");
const { dealerStaffIdsByRole } = await import("../lib/tenancy");
const { generalManagers } = await import("../lib/notify-matrix");
const nonce = randomUUID();
const dealerIds: number[] = [];
const userIds: number[] = [];
const managerEmail = `manager-${nonce}@example.invalid`;
const targetEmail = `member-${nonce}@example.invalid`;
const base = "http://localhost:80/api";
async function request(email: string, dealerId: number | null, path: string, status?: string) {
  const response = await fetch(`${base}${path}`, {
    method: status ? "PATCH" : "GET",
    headers: { "x-test-user-email": email, ...(dealerId == null ? {} : { "x-dealer-id": String(dealerId) }),
      ...(status ? { "content-type": "application/json" } : {}) },
    ...(status ? { body: JSON.stringify({ status }) } : {}),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
try {
  const [role] = await db.select().from(rolesTable).where(eq(rolesTable.name, "General Manager"));
  assert.ok(role, "Seeded GM role required");
  for (const name of ["A", "B"]) {
    const [dealer] = await db.insert(dealersTable).values({ name: `Member isolation ${name} ${nonce}`, status: "active" }).returning();
    dealerIds.push(dealer!.id);
  }
  for (const email of [managerEmail, targetEmail]) {
    const [user] = await db.insert(usersTable).values({ clerkId: `fixture-${email}`, email, name: "Membership Fixture" }).returning();
    userIds.push(user!.id);
    for (const dealerId of dealerIds) {
      await db.insert(dealerUsersTable).values({ dealerId, userId: user!.id, roleId: role.id, isGeneralManager: true });
    }
  }
  const [a, b] = dealerIds as [number, number];
  const [managerId, targetId] = userIds as [number, number];
  const path = `/admin/users/${targetId}`;
  assert.equal((await request(targetEmail, a, "/auth/me")).status, 200);
  assert.equal((await request(targetEmail, b, "/auth/me")).status, 200);
  assert.equal((await request(managerEmail, a, path, "suspended")).status, 200);
  assert.equal((await request(targetEmail, a, "/auth/me")).status, 403, "Suspended dealer denied immediately");
  assert.equal((await request(targetEmail, b, "/auth/me")).status, 200, "Other dealer stays accessible");
  const recovered = await request(targetEmail, null, "/auth/me");
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.activeDealerId, b, "Cleared stale header resolves remaining dealer");
  assert.ok(!(await dealerStaffIdsByRole(a, [role.name])).includes(targetId));
  assert.ok((await dealerStaffIdsByRole(b, [role.name])).includes(targetId));
  assert.ok(!(await generalManagers(a)).includes(targetId), "Notification recipients exclude suspended member");
  assert.ok((await generalManagers(b)).includes(targetId));
  const listA = await request(managerEmail, a, "/admin/users");
  const listB = await request(managerEmail, b, "/admin/users");
  assert.equal((listA.body as unknown as { id: number; status: string }[]).find(u => u.id === targetId)?.status, "suspended");
  assert.equal((listB.body as unknown as { id: number; status: string }[]).find(u => u.id === targetId)?.status, "active");
  const [identity] = await db.select().from(usersTable).where(eq(usersTable.id, targetId));
  assert.equal(identity!.status, "active", "Shared identity not suspended");
  assert.equal((await request(managerEmail, a, path, "active")).status, 200);
  assert.equal((await request(targetEmail, a, "/auth/me")).status, 200);
  assert.equal((await request(managerEmail, a, `/admin/users/${managerId}`, "suspended")).status, 400);
  assert.equal((await request(managerEmail, a, path, "closed")).status, 400);
  // Legacy suspension is retained, but a dealer-specific reactivation overrides
  // it only at that dealer; no migration silently unlocks other memberships.
  await db.update(usersTable).set({ status: "suspended" }).where(eq(usersTable.id, targetId));
  await db.update(dealerUsersTable).set({ status: null }).where(eq(dealerUsersTable.userId, targetId));
  assert.equal((await request(targetEmail, a, "/auth/me")).status, 403);
  assert.equal((await request(targetEmail, b, "/auth/me")).status, 403);
  assert.equal((await request(managerEmail, a, path, "active")).status, 200);
  assert.equal((await request(targetEmail, a, "/auth/me")).status, 200);
  assert.equal((await request(targetEmail, b, "/auth/me")).status, 403);
  console.log("PASS: dealer-only suspension/reactivation, access recovery, staff/notification filters, list status, self-suspension guard and legacy isolation.");
} finally {
  if (userIds.length) await db.delete(auditLogsTable).where(inArray(auditLogsTable.actorUserId, userIds));
  if (dealerIds.length) await db.delete(auditLogsTable).where(inArray(auditLogsTable.dealerId, dealerIds));
  if (userIds.length) await db.delete(dealerUsersTable).where(inArray(dealerUsersTable.userId, userIds));
  if (userIds.length) await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  if (dealerIds.length) await db.delete(dealersTable).where(inArray(dealersTable.id, dealerIds));
  await pool.end();
}
