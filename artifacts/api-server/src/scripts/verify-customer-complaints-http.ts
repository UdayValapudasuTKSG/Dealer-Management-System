/**
 * Against an ALREADY RUNNING local development API. No app startup and no
 * real SMTP: fixture sender points at closed loopback port 1 and recipient
 * addresses use .invalid. Every fixture is uniquely named and removed.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";

const databaseUrl = process.env.DATABASE_URL ?? process.env.DEV_DATABASE_URL;
if (process.env.NODE_ENV === "production" || !databaseUrl ||
  !["helium", "localhost", "127.0.0.1"].includes(new URL(databaseUrl).hostname.toLowerCase()) ||
  (process.env.EXTERNAL_DATABASE_URL && databaseUrl === process.env.EXTERNAL_DATABASE_URL) ||
  (process.env.PROD_DATABASE_URL && databaseUrl === process.env.PROD_DATABASE_URL)) {
  throw new Error("Customer complaint HTTP fixture requires the local development database");
}
const base = process.env.COMPLAINT_TEST_API_BASE ?? "http://localhost:8080/api";
if (!/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/api\/?$/.test(base))
  throw new Error("Only an already-running loopback API is allowed");
const run = randomUUID();
const dealerIds: number[] = [];
const roleIds: number[] = [];
const userIds: number[] = [];
const borrowedRoleGrants: { roleId: number; permission: string }[] = [];
const q = async <T extends Record<string, unknown>>(query: string, args: unknown[] = []) =>
  (await pool.query<T>(query, args)).rows;

async function api(dealerId: number, email: string, path: string, method = "GET", body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      "x-dealer-id": String(dealerId),
      "x-test-user-email": email,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data };
}
async function seedUser(dealerId: number, roleId: number, type: string, manager = false) {
  const email = `${type}-${run}@example.invalid`;
  const [{ id }] = await q<{ id: number }>(
    "INSERT INTO users(clerk_id,email,name) VALUES ($1,$2,$3) RETURNING id",
    [`complaint-http-${run}-${type}`, email, `Fixture ${type}`],
  );
  userIds.push(id);
  await q("INSERT INTO dealer_users(dealer_id,user_id,role_id,is_general_manager) VALUES ($1,$2,$3,$4)",
    [dealerId, id, roleId, manager]);
  return { id, email };
}

try {
  const [{ id: a }] = await q<{ id: number }>("INSERT INTO dealers(name) VALUES ($1) RETURNING id", [`complaint-${run}-a`]);
  const [{ id: b }] = await q<{ id: number }>("INSERT INTO dealers(name) VALUES ($1) RETURNING id", [`complaint-${run}-b`]);
  dealerIds.push(a, b);
  const [{ id: editRole }] = await q<{ id: number }>(
    "INSERT INTO roles(name) VALUES ($1) RETURNING id", [`Complaint fixture editor ${run}`],
  );
  const [{ id: viewRole }] = await q<{ id: number }>(
    "INSERT INTO roles(name) VALUES ($1) RETURNING id", [`Complaint fixture viewer ${run}`],
  );
  roleIds.push(editRole, viewRole);
  // The running API may predate the complaint-specific POST->edit RBAC rule,
  // so include create for backward-compatible HTTP smoke testing.
  for (const [role, permission] of [[editRole, "view"], [editRole, "edit"], [editRole, "create"], [viewRole, "view"]] as const)
    await q("INSERT INTO role_permissions(role_id,module,category) VALUES ($1,'customers',$2)", [role, permission]);
  for (const permission of ["view", "edit"] as const)
    await q("INSERT INTO role_permissions(role_id,module,category) VALUES ($1,'leads',$2)", [editRole, permission]);
  await q("INSERT INTO role_permissions(role_id,module,category) VALUES ($1,'leads','view')", [viewRole]);
  const editor = await seedUser(a, editRole, "editor");
  const viewer = await seedUser(a, viewRole, "viewer");
  const manager = await seedUser(a, viewRole, "manager", true);
  const foreignManager = await seedUser(b, viewRole, "foreign-manager", true);
  const foreignEditor = await seedUser(b, editRole, "foreign-editor");
  const [{ id: customerA }] = await q<{ id: number }>(
    "INSERT INTO customers(dealer_id,name) VALUES ($1,$2) RETURNING id", [a, `Complaint fixture ${run}`],
  );
  const [{ id: customerB }] = await q<{ id: number }>(
    "INSERT INTO customers(dealer_id,name) VALUES ($1,$2) RETURNING id", [b, `Foreign complaint fixture ${run}`],
  );
  const [{ id: leadA }] = await q<{ id: number }>(
    "INSERT INTO leads(dealer_id,customer_id,name) VALUES ($1,$2,$3) RETURNING id", [a, customerA, `Lead ${run}`],
  );
  const [{ id: leadB }] = await q<{ id: number }>(
    "INSERT INTO leads(dealer_id,customer_id,name) VALUES ($1,$2,$3) RETURNING id", [b, customerB, `Lead ${run}`],
  );
  const [{ id: bareLead }] = await q<{ id: number }>(
    "INSERT INTO leads(dealer_id,name,owner_user_id) VALUES ($1,$2,$3) RETURNING id",
    [a, `Unlinked complaint lead ${run}`, editor.id],
  );
  const leadRoute = `/leads/${bareLead}/complaints`;
  const route = `/customers/${customerA}/complaints`;
  const foreignRoute = `/customers/${customerB}/complaints`;
  const create = { title: `Fixture ${run}`, details: "Customer requested a callback", severity: "high", leadId: leadA, escalated: true };

  // A missing per-dealer SMTP connection is a durable complaint, not an
  // invented notification. Nothing is queued or sent.
  let result = await api(a, editor.email, route, "POST", create);
  assert.equal(result.status, 201, JSON.stringify(result.data));
  assert.equal(result.data.notification, "skipped");
  assert.match(result.data.notificationReason, /SMTP/);
  const initialLeadResult = await api(a, editor.email, leadRoute, "POST", {
    title: "Unlinked before SMTP", details: "No customer record", escalated: true,
  });
  assert.equal(initialLeadResult.status, 201, JSON.stringify(initialLeadResult.data));
  assert.equal(initialLeadResult.data.customerId, null);
  assert.equal(initialLeadResult.data.notification, "skipped");
  assert.match(initialLeadResult.data.notificationReason, /SMTP/);
  const skippedId = result.data.id;
  assert.equal(result.data.leadId, leadA);
  result = await api(a, editor.email, `${route}/${skippedId}`, "PATCH", { status: "in_progress" });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.status, "in_progress");
  assert.equal(result.data.notification, "not_requested");
  result = await api(a, viewer.email, route);
  assert.equal(result.status, 200);
  assert.equal(result.data.find((row: { id: number }) => row.id === skippedId).status, "in_progress");
  assert.equal((await api(a, viewer.email, route, "POST", create)).status, 403);
  assert.equal((await api(a, viewer.email, `${route}/${skippedId}`, "PATCH", { status: "closed" })).status, 403);
  assert.equal((await api(a, editor.email, foreignRoute)).status, 404);
  assert.equal((await api(b, foreignEditor.email, route)).status, 404);
  assert.equal((await api(a, editor.email, route, "POST", { ...create, leadId: leadB })).status, 400);
  assert.equal((await api(a, editor.email, route, "POST", { ...create, leadId: 999999999 })).status, 400);

  // Intentionally impossible SMTP transport and .invalid recipients: queue
  // state and recipient policy can be exercised with zero real mail.
  await q(`INSERT INTO smtp_connections(dealer_id,host,port,security,username,password_ciphertext,from_email,enabled)
    VALUES ($1,'127.0.0.1',1,'ssl','fixture','invalid-fixture-ciphertext','sender@example.invalid',true)`, [a]);
  await q("INSERT INTO internal_email_recipients(dealer_id,template_key,user_ids) VALUES ($1,$2,$3)",
    [a, "customer.complaint.escalated", JSON.stringify([])]);
  result = await api(a, editor.email, route, "POST", { ...create, title: `Policy off ${run}` });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  assert.equal(result.data.notification, "skipped");
  assert.match(result.data.notificationReason, /settings/);
  result = await api(a, editor.email, leadRoute, "POST", { title: "Policy off for lead", details: "No customer", escalated: true });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  assert.equal(result.data.notification, "skipped");
  assert.match(result.data.notificationReason, /settings/);
  await q("UPDATE internal_email_recipients SET user_ids=$1 WHERE dealer_id=$2 AND template_key=$3",
    [JSON.stringify([manager.id, foreignManager.id]), a, "customer.complaint.escalated"]);
  result = await api(a, editor.email, route, "POST", { ...create, title: `Created and escalated ${run}` });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  assert.equal(result.data.notification, "queued");
  const createdEscalatedId = result.data.id;
  const [createdOutbox] = await q<{ recipient: string }>(
    "SELECT recipient FROM email_logs WHERE dealer_id=$1 AND dedupe_key=$2",
    [a, `customer:complaint:${createdEscalatedId}:escalation:u${manager.id}`],
  );
  assert.equal(createdOutbox?.recipient, manager.email);
  result = await api(a, editor.email, route, "POST", { ...create, title: `Queue ${run}`, escalated: false });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  assert.equal(result.data.notification, "not_requested");
  const queuedId = result.data.id;
  result = await api(a, editor.email, `${route}/${queuedId}`, "PATCH", { escalated: true, status: "resolved" });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.notification, "queued");
  assert.equal(result.data.status, "resolved");
  const [outbox] = await q<{ recipient: string; dealer_id: number; customer_id: number; lead_id: number; payload: Record<string, string> }>(
    "SELECT recipient,dealer_id,customer_id,lead_id,payload FROM email_logs WHERE dealer_id=$1 AND dedupe_key=$2",
    [a, `customer:complaint:${queuedId}:escalation:u${manager.id}`],
  );
  assert.equal(outbox?.recipient, manager.email);
  assert.equal(outbox?.dealer_id, a);
  assert.equal(outbox?.customer_id, customerA);
  assert.equal(outbox?.lead_id, leadA);
  assert.equal(outbox?.payload.title, `Queue ${run}`);
  assert.ok(outbox?.payload.link.includes(`/customers/${customerA}?tab=complaints`));
  const count = await q<{ count: string }>(
    "SELECT count(*)::text FROM email_logs WHERE dealer_id=$1 AND template=$2",
    [a, "customer.complaint.escalated"],
  );
  assert.equal(count[0].count, "2", "Only the same-dealer manager should be queued once per escalation");
  result = await api(a, editor.email, `${route}/${queuedId}`, "PATCH", { escalated: true });
  assert.equal(result.status, 200);
  assert.equal(result.data.notification, "not_requested");
  assert.equal((await q<{ count: string }>(
    "SELECT count(*)::text FROM email_logs WHERE dealer_id=$1 AND template=$2",
    [a, "customer.complaint.escalated"],
  ))[0].count, "2", "Repeated escalation must not enqueue another email");
  assert.equal((await q<{ count: string }>(
    "SELECT count(*)::text FROM email_logs WHERE dealer_id=$1 AND template=$2",
    [b, "customer.complaint.escalated"],
  ))[0].count, "0");
  result = await api(a, editor.email, route);
  assert.equal(result.status, 200);
  assert.equal(result.data.find((row: { id: number }) => row.id === queuedId).status, "resolved");

  // Lead-only complaints never manufacture a customer; the same complaint
  // also appears on the customer tab if the lead already has a customer.
  result = await api(a, editor.email, leadRoute, "POST", { title: "No customer", details: "Call centre concern", escalated: true });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  assert.equal(result.data.customerId, null);
  assert.equal(result.data.leadId, bareLead);
  assert.equal(result.data.notification, "queued");
  const leadComplaintId = result.data.id;
  const [leadOutbox] = await q<{ recipient: string; customer_id: number | null; lead_id: number; payload: Record<string, string> }>(
    "SELECT recipient,customer_id,lead_id,payload FROM email_logs WHERE dealer_id=$1 AND dedupe_key=$2",
    [a, `customer:complaint:${leadComplaintId}:escalation:u${manager.id}`],
  );
  assert.equal(leadOutbox?.recipient, manager.email);
  assert.equal(leadOutbox?.customer_id, null);
  assert.equal(leadOutbox?.lead_id, bareLead);
  assert.ok(leadOutbox?.payload.link.includes(`/lead/${bareLead}?tab=complaints`));
  result = await api(a, editor.email, `${leadRoute}/${leadComplaintId}`, "PATCH", { status: "in_progress" });
  assert.equal(result.status, 200);
  assert.equal(result.data.status, "in_progress");
  assert.equal(result.data.notification, "not_requested");
  result = await api(a, editor.email, leadRoute);
  assert.equal(result.status, 200);
  assert.equal(result.data.find((row: { id: number }) => row.id === leadComplaintId).status, "in_progress");
  result = await api(a, editor.email, leadRoute, "POST", { title: "Escalate later", details: "Follow-up concern", escalated: false });
  assert.equal(result.status, 201);
  assert.equal(result.data.notification, "not_requested");
  const laterId = result.data.id;
  result = await api(a, editor.email, `${leadRoute}/${laterId}`, "PATCH", { escalated: true, status: "resolved" });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.notification, "queued");
  assert.equal(result.data.status, "resolved");
  const [laterOutbox] = await q<{ recipient: string }>(
    "SELECT recipient FROM email_logs WHERE dealer_id=$1 AND dedupe_key=$2",
    [a, `customer:complaint:${laterId}:escalation:u${manager.id}`],
  );
  assert.equal(laterOutbox?.recipient, manager.email);
  assert.equal((await api(a, editor.email, `${leadRoute}/${laterId}`, "PATCH", { escalated: true })).data.notification, "not_requested");
  assert.equal((await api(a, viewer.email, leadRoute, "POST", create)).status, 403);
  assert.equal((await api(a, editor.email, `/leads/${leadB}/complaints`)).status, 404);
  assert.equal((await api(a, editor.email, `/leads/${leadA}/complaints/${leadComplaintId}`, "PATCH", { status: "closed" })).status, 404);
  result = await api(a, editor.email, `/leads/${leadA}/complaints`, "POST", { title: "Linked", details: "Customer linked concern", escalated: false });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  assert.equal(result.data.customerId, customerA);
  assert.equal(result.data.notification, "not_requested");
  const linkedId = result.data.id;
  result = await api(a, viewer.email, route);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.ok(result.data.some((row: { id: number }) => row.id === linkedId));
  result = await api(a, viewer.email, `/leads/${leadA}/complaints`);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.ok(result.data.some((row: { id: number }) => row.id === linkedId));

  // Historical rep visibility survives transfer but mutation access does not.
  let [{ id: repRole } = { id: 0 }] = await q<{ id: number }>("SELECT id FROM roles WHERE name='Call Centre Representative' LIMIT 1");
  if (!repRole) {
    [{ id: repRole }] = await q<{ id: number }>("INSERT INTO roles(name) VALUES ('Call Centre Representative') RETURNING id");
    roleIds.push(repRole);
  }
  const rep = await seedUser(a, repRole, "rep");
  const [{ id: repLead }] = await q<{ id: number }>(
    "INSERT INTO leads(dealer_id,name,owner_user_id,assigned_to,call_centre_rep_id,call_centre_status,call_centre_assigned_at) VALUES ($1,$2,$3,$4,$3,'pending',now()) RETURNING id",
    [a, `Rep lead ${run}`, rep.id, "Fixture rep"],
  );
  const repRoute = `/leads/${repLead}/complaints`;
  // Existing dealer-defined role may lack these permissions; add fixture
  // grants only when necessary and remove only those grants on teardown.
  for (const permission of ["view", "edit"]) {
    const existing = await q("SELECT 1 FROM role_permissions WHERE role_id=$1 AND module='leads' AND category=$2", [repRole, permission]);
    if (!existing.length) {
      await q("INSERT INTO role_permissions(role_id,module,category) VALUES ($1,'leads',$2)", [repRole, permission]);
      borrowedRoleGrants.push({ roleId: repRole, permission });
    }
  }
  result = await api(a, rep.email, repRoute, "POST", { title: "Rep concern", details: "No linked customer", escalated: false });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  const repComplaintId = result.data.id;
  await q("UPDATE leads SET call_centre_status='transferred',call_centre_transferred_at=now() WHERE id=$1", [repLead]);
  assert.equal((await api(a, rep.email, repRoute)).status, 200);
  assert.equal((await api(a, rep.email, repRoute, "POST", { title: "Late", details: "Late" })).status, 403);
  assert.equal((await api(a, rep.email, `${repRoute}/${repComplaintId}`, "PATCH", { escalated: true })).status, 403);
  assert.equal((await api(a, rep.email, leadRoute)).status, 403);
  console.log("Customer/lead complaint HTTP regression passed: nullable customer, linked history, tenancy, ownership, rep transfer, SMTP/policy disposition and manager outbox.");
} finally {
  // Remove only marker-owned fixtures. Disable the fake transport FIRST so a
  // concurrent worker cannot process anything while teardown runs.
  for (const dealerId of dealerIds)
    await q("UPDATE smtp_connections SET enabled=false WHERE dealer_id=$1", [dealerId]);
  for (const dealerId of dealerIds) {
    await q("DELETE FROM email_logs WHERE dealer_id=$1", [dealerId]);
    await q("DELETE FROM audit_logs WHERE dealer_id=$1", [dealerId]);
    await q("DELETE FROM internal_email_recipients WHERE dealer_id=$1", [dealerId]);
    await q("DELETE FROM smtp_connections WHERE dealer_id=$1", [dealerId]);
    await q("DELETE FROM customer_complaints WHERE dealer_id=$1", [dealerId]);
    await q("DELETE FROM leads WHERE dealer_id=$1", [dealerId]);
    await q("DELETE FROM customers WHERE dealer_id=$1", [dealerId]);
    await q("DELETE FROM dealer_users WHERE dealer_id=$1", [dealerId]);
  }
  for (const userId of userIds) await q("DELETE FROM users WHERE id=$1", [userId]);
  for (const { roleId, permission } of borrowedRoleGrants)
    await q("DELETE FROM role_permissions WHERE role_id=$1 AND module='leads' AND category=$2", [roleId, permission]);
  for (const roleId of roleIds) await q("DELETE FROM role_permissions WHERE role_id=$1", [roleId]);
  for (const roleId of roleIds) await q("DELETE FROM roles WHERE id=$1", [roleId]);
  for (const dealerId of dealerIds) await q("DELETE FROM dealers WHERE id=$1", [dealerId]);
  await pool.end();
}