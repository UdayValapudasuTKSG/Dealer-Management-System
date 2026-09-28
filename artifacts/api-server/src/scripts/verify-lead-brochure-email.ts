/**
 * Development-only HTTP contract + real outbox regression. Fixture recipients
 * are @example.test and OUTBOX_WORKER_DISABLED is set before any app import.
 * No SMTP transport sendMail is called and no customer address is used.
 */
import assert from "node:assert/strict";

function refuse(reason: string): never {
  console.error(`verify-lead-brochure-email refuses to run: ${reason}`);
  process.exit(1);
}
if (process.env.NODE_ENV === "production") refuse("production environment");
process.env.NODE_ENV = "test";
process.env.OUTBOX_WORKER_DISABLED = "1";
const rawUrl = process.env.DATABASE_URL ?? process.env.DEV_DATABASE_URL;
if (!rawUrl) refuse("development database unavailable");
const host = new URL(rawUrl).hostname.toLowerCase();
if (!["helium", "localhost", "127.0.0.1"].includes(host))
  refuse("database host is not a local development database");
if (process.env.PROD_DATABASE_URL) {
  const prod = new URL(process.env.PROD_DATABASE_URL);
  const dev = new URL(rawUrl);
  if (prod.hostname === dev.hostname && prod.pathname === dev.pathname)
    refuse("database matches production database");
}

const { default: express } = await import("express");
const { and, eq, like, sql } = await import("drizzle-orm");
const { db, dealersTable, emailLogsTable, leadsTable, pool, timelineEventsTable } =
  await import("@workspace/db");
const { default: leadRouter } = await import("../routes/leads");
const { preflightDealerEmailSender } = await import("../lib/email");
const { loadBrochureAttachments } = await import("../lib/lead-brochures");

const [gt] = await db.select({ name: dealersTable.name }).from(dealersTable).where(eq(dealersTable.id, 1));
if (gt?.name !== "GT Automotive") refuse("dealer 1 is not GT Automotive");
const sender = await preflightDealerEmailSender(1);
if (!sender.ok) refuse("GT Automotive SMTP not configured in dev; success-path fixture cannot run");

const fixture = `verify-brochure-${process.pid}-${Date.now()}`;
const [otherDealer] = await db.insert(dealersTable).values({ name: fixture }).returning();
const [lead] = await db.insert(leadsTable).values({
  dealerId: 1, name: fixture, ownerUserId: 1_999_951,
  assignedTo: fixture, email: `${fixture}@example.test`,
}).returning();
const [noEmailLead] = await db.insert(leadsTable).values({
  dealerId: 1, name: `${fixture}-no-email`, ownerUserId: 1_999_951,
  assignedTo: fixture, email: null,
}).returning();
assert.ok(otherDealer && lead && noEmailLead);

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.locals.dealerId = Number(req.headers["x-test-dealer"] ?? 1);
  res.locals.user = {
    id: Number(req.headers["x-test-actor"] ?? 1_999_951),
    name: fixture, email: `${fixture}@example.test`, roleName: "Sales Advisor",
  } as typeof res.locals.user;
  next();
});
app.use("/api", leadRouter);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
const base = `http://127.0.0.1:${address.port}/api/leads`;

async function request(id: number, method: "GET" | "POST", body?: object, headers?: Record<string, string>) {
  const response = await fetch(`${base}/${id}/brochures`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, data: await response.json() as Record<string, any> | Array<Record<string, any>> };
}

try {
  const catalog = await request(lead.id, "GET");
  assert.equal(catalog.status, 200);
  assert.equal((catalog.data as any[]).length, 7);
  assert.equal((catalog.data as any[]).every((b) => b.sendable), true);
  const derivative = await loadBrochureAttachments(["sealion-7"]);
  assert.equal(derivative.length, 1);
  assert.ok(derivative[0].content.length < 10 * 1024 * 1024);

  const notOwned = await request(lead.id, "POST",
    { brochureIds: ["shark"], idempotencyKey: crypto.randomUUID() },
    { "x-test-actor": "1999952" });
  assert.equal(notOwned.status, 403);
  assert.equal((notOwned.data as any).code, "lead_not_owned");
  const other = await request(lead.id, "GET", undefined, { "x-test-dealer": String(otherDealer.id) });
  assert.equal(other.status, 404, "other dealer cannot view GT lead/catalog");
  const missing = await request(noEmailLead.id, "POST",
    { brochureIds: ["shark"], idempotencyKey: crypto.randomUUID() });
  assert.equal(missing.status, 422);
  assert.match((missing.data as any).error, /no valid customer email/i);
  const invalid = await request(lead.id, "POST",
    { brochureIds: ["../../etc/passwd"], idempotencyKey: crypto.randomUUID() });
  assert.equal(invalid.status, 422);

  const key = crypto.randomUUID();
  const body = { brochureIds: ["sealion-7", "shark"], idempotencyKey: key };
  const [first, second] = await Promise.all([
    request(lead.id, "POST", body),
    request(lead.id, "POST", body),
  ]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal((first.data as any).status, "queued");
  assert.deepEqual((first.data as any).brochureIds, ["sealion-7", "shark"]);
  const dedupeKey = `brochures:1:${lead.id}:${key}`;
  const rows = await db.select().from(emailLogsTable).where(eq(emailLogsTable.dedupeKey, dedupeKey));
  assert.equal(rows.length, 1, "parallel double-submit queued exactly once");
  assert.equal(rows[0].recipient, lead.email);
  assert.equal(rows[0].payload.brochureIdsJson, JSON.stringify(body.brochureIds));
  const queuedEvents = await db.select().from(timelineEventsTable).where(and(
    eq(timelineEventsTable.dealerId, 1), eq(timelineEventsTable.refType, "lead"),
    eq(timelineEventsTable.refId, lead.id), eq(timelineEventsTable.kind, "brochures_queued"),
  ));
  assert.equal(queuedEvents.length, 1, "parallel double-submit has one timeline request event");
  const replay = await request(lead.id, "POST", body);
  assert.equal(replay.status, 200);
  assert.equal((await db.select().from(emailLogsTable).where(eq(emailLogsTable.dedupeKey, dedupeKey))).length, 1);
  const mismatch = await request(lead.id, "POST", { brochureIds: ["yuan-plus"], idempotencyKey: key });
  assert.equal(mismatch.status, 409);
  const allIds = (catalog.data as any[]).map((b) => b.id as string);
  const seven = await request(lead.id, "POST", { brochureIds: allIds, idempotencyKey: crypto.randomUUID() });
  assert.equal(seven.status, 200, "all seven brochures can be queued in one email");
  assert.equal((seven.data as any).status, "queued");
  assert.equal((seven.data as any).brochureIds.length, 7);
  const noSmtp = await preflightDealerEmailSender(otherDealer.id);
  assert.equal(noSmtp.ok, false, "unconfigured dealer has explicit missing-SMTP preflight");
  if (!noSmtp.ok) assert.match(noSmtp.message, /not configured/i);
  console.log("PASS: seven selectable PDFs, actual private attachment, protected ownership, isolation, missing-email/SMTP, concurrent enqueue and replay. SMTP disabled throughout.");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.delete(timelineEventsTable).where(and(
    eq(timelineEventsTable.dealerId, 1), eq(timelineEventsTable.refType, "lead"),
    sql`${timelineEventsTable.refId} in (${lead.id}, ${noEmailLead.id})`,
  ));
  await db.delete(emailLogsTable).where(like(emailLogsTable.dedupeKey, `brochures:1:${lead.id}:%`));
  await db.delete(leadsTable).where(eq(leadsTable.id, noEmailLead.id));
  await db.delete(leadsTable).where(eq(leadsTable.id, lead.id));
  await db.delete(dealersTable).where(eq(dealersTable.id, otherDealer.id));
  await pool.end();
}