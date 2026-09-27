/**
 * Dev-only real-DB contract suite. Every email is only queued; the global
 * worker is disabled BEFORE importing application modules. No SMTP calls.
 */
import assert from "node:assert/strict";
export {};
function refuse(reason: string): never {
  throw new Error(`Internal-email fixture refuses to run: ${reason}`);
}
if (process.env.NODE_ENV === "production") refuse("production environment");
const url = process.env.DATABASE_URL ?? process.env.DEV_DATABASE_URL;
if (!url) refuse("missing development database URL");
let host: string;
try { host = new URL(url).hostname.toLowerCase(); } catch { refuse("invalid database URL"); }
if (!["helium", "localhost", "127.0.0.1"].includes(host)) refuse(`not a dev host (${host})`);
if (process.env.PROD_DATABASE_URL) {
  const prod = new URL(process.env.PROD_DATABASE_URL);
  if (prod.hostname === host && prod.pathname === new URL(url).pathname) refuse("production database target");
}
process.env.OUTBOX_WORKER_DISABLED = "1";
process.env.NODE_ENV = "test";

const { pool } = await import("@workspace/db");
const { enqueueEmail, revalidateInternalEmailOutbox } = await import("../lib/email");
const { sweepLeadSourceReports, sweepServiceSummaries } = await import("../lib/notification-sweeps");
const { updateServiceSettings } = await import("../lib/service-settings");
const { validateInternalRecipientSelection } = await import("../lib/internal-email-recipients");
const run = `verify-internal-email-${Date.now()}-${process.pid}`;
const dealers: number[] = [];
const users: number[] = [];
const roles: number[] = [];
const email = (suffix: string) => `${run}-${suffix}@aura-test.local`;

async function dealer(suffix: string) {
  const { rows } = await pool.query(
    "INSERT INTO dealers (name, status) VALUES ($1, 'active') RETURNING id",
    [`Verify internal routing ${run}-${suffix}`],
  );
  dealers.push(rows[0].id);
  return rows[0].id as number;
}
async function role(suffix: string, hasView: boolean, module = "leads") {
  const { rows } = await pool.query(
    "INSERT INTO roles (name) VALUES ($1) RETURNING id", [`Verify internal ${run}-${suffix}`],
  );
  const id = rows[0].id as number;
  roles.push(id);
  if (hasView) await pool.query(
    "INSERT INTO role_permissions (role_id, module, category) VALUES ($1, $2, 'view')", [id, module],
  );
  return id;
}
async function user(dealerId: number, roleId: number, suffix: string, active = true) {
  const { rows } = await pool.query(
    "INSERT INTO users (clerk_id, email, name, status) VALUES ($1,$2,$3,$4) RETURNING id",
    [`${run}-${suffix}`, email(suffix), suffix, active ? "active" : "suspended"],
  );
  const id = rows[0].id as number;
  users.push(id);
  await pool.query(
    "INSERT INTO dealer_users (dealer_id, user_id, role_id) VALUES ($1,$2,$3)",
    [dealerId, id, roleId],
  );
  return id;
}
async function setPolicy(dealerId: number, userIds: number[], template = "lead.new") {
  await pool.query(
    `INSERT INTO internal_email_recipients (dealer_id, template_key, user_ids)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (dealer_id, template_key) DO UPDATE SET user_ids = EXCLUDED.user_ids`,
    [dealerId, template, JSON.stringify(userIds)],
  );
}
async function resetPolicy(dealerId: number) {
  await pool.query("DELETE FROM internal_email_recipients WHERE dealer_id=$1", [dealerId]);
}
async function count(key: string) {
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM email_logs WHERE dedupe_key=$1", [key]);
  return rows[0].n as number;
}
async function cleanup() {
  if (dealers.length) {
    await pool.query("DELETE FROM email_logs WHERE dealer_id = ANY($1::int[])", [dealers]);
    await pool.query("DELETE FROM internal_email_recipients WHERE dealer_id = ANY($1::int[])", [dealers]);
    await pool.query("DELETE FROM dealer_service_settings WHERE dealer_id = ANY($1::int[])", [dealers]);
    await pool.query("DELETE FROM dealer_users WHERE dealer_id = ANY($1::int[])", [dealers]);
  }
  if (users.length) await pool.query("DELETE FROM users WHERE id = ANY($1::int[])", [users]);
  if (dealers.length) await pool.query("DELETE FROM dealers WHERE id = ANY($1::int[])", [dealers]);
  if (roles.length) await pool.query("DELETE FROM roles WHERE id = ANY($1::int[])", [roles]);
}
try {
  const a = await dealer("a");
  const b = await dealer("b");
  const visible = await role("view", true);
  const hidden = await role("hidden", false);
  const gm1 = await user(a, visible, "gm1");
  const gm2 = await user(a, visible, "gm2");
  const staff = await user(a, visible, "staff");
  const noView = await user(a, hidden, "hidden");
  const inactive = await user(a, visible, "inactive", false);
  const other = await user(b, visible, "other");
  const serviceRole = await role("service", true, "service");
  const serviceStaff = await user(a, serviceRole, "service-staff");
  assert.equal(await validateInternalRecipientSelection(a, "lead.new", [staff]), true);
  for (const invalid of [other, noView, inactive, 123456789]) {
    assert.equal(await validateInternalRecipientSelection(a, "lead.new", [invalid]), false);
  }
  assert.equal(await validateInternalRecipientSelection(a, "lead.new", [staff, staff]), false);

  const basic = await enqueueEmail({ dealerId: a, template: "lead.new", to: email("gm1"),
    dedupeKey: `${run}:default:u${gm1}`, data: { name: "Fixture" } });
  assert.equal(basic.status, "queued");
  assert.equal(basic.recipient, email("gm1"));
  // Dealer B settings cannot change A's routing.
  await setPolicy(b, [other]);
  const separate = await enqueueEmail({ dealerId: a, template: "lead.new", to: email("gm2"),
    dedupeKey: `${run}:isolation:u${gm2}` });
  assert.equal(separate.recipient, email("gm2"));

  await setPolicy(a, [staff]);
  assert.equal(await revalidateInternalEmailOutbox(basic), false);
  assert.equal((await pool.query("SELECT status FROM email_logs WHERE id=$1", [basic.id])).rows[0].status, "cancelled");
  const base = `${run}:custom`;
  const first = await enqueueEmail({ dealerId: a, template: "lead.new", to: email("gm1"),
    dedupeKey: `${base}:u${gm1}`, data: { name: "Fixture" } });
  const second = await enqueueEmail({ dealerId: a, template: "lead.new", to: email("gm2"),
    dedupeKey: `${base}:u${gm2}`, data: { name: "Fixture" } });
  assert.equal(first.id, second.id);
  assert.equal(first.recipient, email("staff"));
  assert.equal(await count(`${base}:internal:u${staff}`), 1);
  await setPolicy(a, []);
  assert.equal(await revalidateInternalEmailOutbox(first), false);
  const disabled = await enqueueEmail({ dealerId: a, template: "lead.new", to: email("gm1"),
    dedupeKey: `${run}:disabled:u${gm1}` });
  assert.equal(disabled.status, "cancelled");
  assert.equal(disabled.lastError, "suppressed: no eligible internal email recipients");
  const bypass = await enqueueEmail({ dealerId: a, template: "lead.new", to: email("gm1"),
    dedupeKey: `${run}:bypass`, bypassInternalRouting: true,
    data: { internalRouted: "1", internalRoutingBypass: "0" } });
  assert.equal(bypass.payload.internalRoutingBypass, "1");
  assert.equal(bypass.payload.internalRouted, undefined);
  assert.equal(await revalidateInternalEmailOutbox(bypass), true);
  const forged = await enqueueEmail({ dealerId: a, template: "lead.new", to: email("gm1"),
    dedupeKey: `${run}:forged`, data: { internalRoutingBypass: "1" } });
  assert.equal(forged.status, "cancelled");
  await setPolicy(a, [staff]);
  const customAfter = await enqueueEmail({ dealerId: a, template: "lead.new", to: email("gm1"),
    dedupeKey: `${run}:reset`, data: { name: "Fixture" } });
  assert.equal(customAfter.payload.internalRouted, "1");
  await resetPolicy(a);
  assert.equal(await revalidateInternalEmailOutbox(customAfter), false);
  const restored = await enqueueEmail({ dealerId: a, template: "lead.new", to: email("gm1"),
    dedupeKey: `${run}:restored` });
  assert.equal(restored.status, "queued");
  assert.equal(restored.recipient, email("gm1"));
  // No fixture member is marked GM or has service admin/approve. Explicit
  // settings must still cause each scoped sweep to enqueue its custom staff.
  await setPolicy(a, [staff], "leads.source.report.daily");
  await setPolicy(a, [serviceStaff], "service.summary.management");
  await updateServiceSettings(a, {
    leadSourceReportEnabled: true, leadSourceReportSendTime: "00:00", summaryCadence: "daily",
  });
  await sweepLeadSourceReports([a]);
  await sweepServiceSummaries([a]);
  const { rows: digests } = await pool.query(
    `SELECT template, recipient FROM email_logs WHERE dealer_id=$1
     AND template IN ('leads.source.report.daily', 'service.summary.management') AND status='queued'`,
    [a],
  );
  assert.equal(digests.filter(r => r.template === "leads.source.report.daily" && r.recipient === email("staff")).length, 1);
  assert.equal(digests.filter(r => r.template === "service.summary.management" && r.recipient === email("service-staff")).length, 1);
  console.log("PASS: default/custom/off/reset, dealer isolation, view, dedupe, pending cancellation, bypass spoofing, no-GM report/service sweeps (zero sends)");
} finally {
  try { await cleanup(); } finally { await pool.end(); }
}