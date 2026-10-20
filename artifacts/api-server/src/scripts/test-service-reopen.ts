import assert from "node:assert/strict";
import type { Request, Response } from "express";

// Opt-in isolated fixtures only. Guard before importing the database or routes.
if (process.env.VERIFY_SERVICE_REOPEN !== "1" || process.env.NODE_ENV === "production")
  throw new Error("Development fixture test requires VERIFY_SERVICE_REOPEN=1");
const target = new URL(process.env.DATABASE_URL ?? process.env.DEV_DATABASE_URL ?? "");
if (!["helium", "localhost", "127.0.0.1"].includes(target.hostname))
  throw new Error("Not an allowlisted development database");
if (process.env.PROD_DATABASE_URL) {
  const prod = new URL(process.env.PROD_DATABASE_URL);
  if (prod.hostname === target.hostname && prod.pathname === target.pathname) throw new Error("Production target refused");
}
process.env.OUTBOX_WORKER_DISABLED = "1";
const { db, pool, dealersTable, usersTable, serviceOrdersTable, jobCardsTable,
  tasksTable, notificationsTable, timelineEventsTable, serviceInvoicesTable } = await import("@workspace/db");
const { eq } = await import("drizzle-orm");
const { default: router } = await import("../routes/service");
const marker = `service-reopen-test-${Date.now()}`;
const [dealer] = await db.insert(dealersTable).values({ name: marker }).returning();
const [user] = await db.insert(usersTable).values({ clerkId: marker, name: "Reopen test technician" }).returning();
type Result = { statusCode: number; body?: any; headersSent: boolean; locals: Record<string, unknown>; status: (n: number) => Result; json: (v: unknown) => Result };
async function invoke(path: string, method: string, id: number, body: unknown, dealerId = dealer.id): Promise<Result> {
  const response: Result = {
    statusCode: 200, headersSent: false, locals: { dealerId, user: { id: user.id, name: "Fixture", roleName: "General Manager", isSuperAdmin: false } },
    status(n) { this.statusCode = n; return this; },
    json(v) { this.body = v; this.headersSent = true; return this; },
  };
  const route = router.stack.find((layer: any) => layer.route?.path === path && layer.route.methods[method])?.route;
  assert.ok(route, path);
  for (const layer of route.stack) await layer.handle(
    { params: { id: String(id) }, body, query: {}, log: { error() {}, warn() {}, info() {} } } as unknown as Request,
    response as unknown as Response, () => {},
  );
  return response;
}
try {
  const [booking] = await db.insert(serviceOrdersTable).values({
    dealerId: dealer.id, vehicleInfo: "Isolated reopen test", type: "service", payType: "goodwill",
    status: "closed", closedAt: new Date(), scheduledDate: "2026-10-20",
  }).returning();
  const [job] = await db.insert(jobCardsTable).values({
    dealerId: dealer.id, serviceOrderId: booking.id, title: marker, status: "completed",
    technicianUserId: user.id, technicianName: "Reopen test technician", payType: "goodwill",
    completedAt: new Date(), laborRate: 0, serviceAnalysis: "Fixture analysis", workPerformed: "Fixture work",
  }).returning();
  assert.equal((await invoke("/job-cards/:id/reopen", "post", job.id, {}, dealer.id + 99999)).statusCode, 404);
  const results = await Promise.all([
    invoke("/job-cards/:id/reopen", "post", job.id, { reason: "Recheck" }),
    invoke("/job-cards/:id/reopen", "post", job.id, { reason: "Recheck" }),
  ]);
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409], JSON.stringify(results));
  const [reopened] = await db.select().from(serviceOrdersTable).where(eq(serviceOrdersTable.id, booking.id));
  assert.equal(reopened.status, "in_progress");
  assert.equal(reopened.closedAt, null);
  const tasks = await db.select().from(tasksTable).where(eq(tasksTable.dealerId, dealer.id));
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].assigneeUserId, user.id);
  assert.equal(tasks[0].priority, "high");
  const messages = await db.select().from(notificationsTable).where(eq(notificationsTable.dealerId, dealer.id));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].link, `/service/job-cards/${job.id}`);
  assert.match(messages[0].body!, /on time/);
  const complete = await invoke("/job-cards/:id", "patch", job.id, { status: "completed" });
  assert.equal(complete.statusCode, 200, JSON.stringify(complete.body));
  const [resolved] = await db.select().from(serviceOrdersTable).where(eq(serviceOrdersTable.id, booking.id));
  assert.equal(resolved.status, "resolved");
  const [closedTask] = await db.select().from(tasksTable).where(eq(tasksTable.id, tasks[0].id));
  assert.equal(closedTask.status, "done");
  await db.update(serviceOrdersTable).set({ status: "cancelled" }).where(eq(serviceOrdersTable.id, booking.id));
  assert.equal((await invoke("/job-cards/:id/reopen", "post", job.id, {})).statusCode, 409);
  console.log("PASS reopen/booking sync, concurrent duplicate, dealer isolation, urgent task, technician notice, completion and cancelled-booking guard");
} finally {
  for (const table of ["service_invoice_parts_charges", "workshop_invoice_oils", "erpnext_sync_jobs", "email_logs"]) {
    await pool.query(`delete from ${table} where dealer_id = $1`, [dealer.id]);
  }
  for (const table of [notificationsTable, tasksTable, timelineEventsTable, serviceInvoicesTable, jobCardsTable, serviceOrdersTable]) {
    await db.delete(table).where(eq(table.dealerId, dealer.id));
  }
  await db.delete(usersTable).where(eq(usersTable.id, user.id));
  await db.delete(dealersTable).where(eq(dealersTable.id, dealer.id));
  await pool.end();
}
