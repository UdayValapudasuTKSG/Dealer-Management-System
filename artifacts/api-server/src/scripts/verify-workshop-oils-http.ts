/**
 * Live HTTP regression against the already-running development API.
 * Explicit opt-in only. Creates an isolated dealer without ERP credentials or
 * customer contact; all synthetic records are deleted in finally.
 */
import { randomBytes } from "node:crypto";
import { strict as assert } from "node:assert";

if (process.env.NODE_ENV !== "development" || process.env.OUTBOX_WORKER_DISABLED !== "1" ||
    process.env.VERIFY_WORKSHOP_OILS_HTTP !== "1" || process.env.EXTERNAL_DATABASE_URL) {
  throw new Error("Development-only: require NODE_ENV=development OUTBOX_WORKER_DISABLED=1 VERIFY_WORKSHOP_OILS_HTTP=1, without EXTERNAL_DATABASE_URL");
}
const url = process.env.DATABASE_URL ?? process.env.DEV_DATABASE_URL;
if (!url || !["helium", "localhost", "127.0.0.1"].includes(new URL(url).hostname.toLowerCase()))
  throw new Error("Refusing non-local development database");
const base = process.env.VERIFY_API_BASE ?? "http://localhost:80/api";
if (!["localhost", "127.0.0.1"].includes(new URL(base).hostname.toLowerCase()))
  throw new Error("Refusing non-loopback API");
const { pool } = await import("@workspace/db");
const tag = `oil-http-${randomBytes(6).toString("hex")}`;
const emails = {
  tech: `${tag}-tech@example.invalid`,
  other: `${tag}-other@example.invalid`,
  parts: `${tag}-parts@example.invalid`,
  manager: `${tag}-manager@example.invalid`,
};
let dealerId = 0;
let userIds: number[] = [];
async function request(path: string, actor: keyof typeof emails, method = "GET", data?: unknown, dealer = dealerId) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { "x-test-user-email": emails[actor], "x-dealer-id": String(dealer),
      ...(data !== undefined ? { "content-type": "application/json" } : {}) },
    ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
  });
  const raw = await res.text();
  let body: any;
  try { body = JSON.parse(raw); } catch { body = raw; }
  return { status: res.status, body };
}
function status(result: { status: number; body: any }, expected: number, label: string) {
  assert.equal(result.status, expected, `${label}: ${JSON.stringify(result.body)}`);
  return result.body;
}
async function cleanup() {
  if (!dealerId) return;
  // These are all owned by this unique synthetic dealership. No real dealer
  // rows, invoice or stock are queried for deletion.
  const tables = [
    "workshop_invoice_oils", "service_invoice_parts_charges",
    "workshop_oil_movements", "workshop_oil_requests",
    "erpnext_sync_jobs", "email_logs", "service_estimate_decisions",
    "service_invoices", "job_cards", "service_orders", "workshop_oils",
    "dealer_taxes", "dealer_users",
  ];
  for (const table of tables) await pool.query(`DELETE FROM ${table} WHERE dealer_id=$1`, [dealerId]);
  if (userIds.length) await pool.query("DELETE FROM users WHERE id=ANY($1::integer[])", [userIds]);
  await pool.query("DELETE FROM dealers WHERE id=$1", [dealerId]);
}
try {
  const roles = await pool.query<{ id: number; name: string }>(
    "SELECT id,name FROM roles WHERE name=ANY($1::text[])", [["Technician", "Parts Advisor", "General Manager"]],
  );
  const role = (name: string) => {
    const found = roles.rows.find(r => r.name === name);
    if (!found) throw new Error(`Required RBAC role missing: ${name}`);
    return found.id;
  };
  const dealer = await pool.query<{ id: number }>(
    "INSERT INTO dealers (name,status,timezone,entitlements) VALUES ($1,'active','America/Guyana','{}'::jsonb) RETURNING id",
    [tag],
  );
  dealerId = dealer.rows[0]!.id;
  for (const actor of ["tech", "other", "parts", "manager"] as const) {
    const roleId = role(actor === "parts" ? "Parts Advisor" : actor === "manager" ? "General Manager" : "Technician");
    const u = await pool.query<{ id: number }>(
      "INSERT INTO users (clerk_id,email,name,role_id,status) VALUES ($1,$2,$3,$4,'active') RETURNING id",
      [`${tag}-${actor}`, emails[actor], `${tag} ${actor}`, roleId],
    );
    const id = u.rows[0]!.id;
    userIds.push(id);
    await pool.query(
      "INSERT INTO dealer_users (dealer_id,user_id,role_id,is_general_manager) VALUES ($1,$2,$3,$4)",
      [dealerId, id, roleId, actor === "manager"],
    );
  }
  const techId = userIds[0]!;
  const order = await pool.query<{ id: number }>(
    "INSERT INTO service_orders (dealer_id,vehicle_info,scheduled_date,pay_type,technician_user_id,technician) VALUES ($1,$2,CURRENT_DATE,'customer',$3,$4) RETURNING id",
    [dealerId, tag, techId, `${tag} tech`],
  );
  const card = await pool.query<{ id: number }>(
    "INSERT INTO job_cards (dealer_id,service_order_id,title,pay_type,technician_user_id,technician_name,labor_hours) VALUES ($1,$2,$3,'customer',$4,$5,0) RETURNING id",
    [dealerId, order.rows[0]!.id, tag, techId, `${tag} tech`],
  );
  const jobId = card.rows[0]!.id;
  const oil = status(await request("/parts/oils", "parts", "POST", {
    name: `${tag} 5W-30`, grade: "5W-30", specification: "API SP", brand: tag,
    purchaseCostPerLitre: 700, sellingPricePerLitre: 1234.56,
    stockLitres: 10, reorderLitres: 2,
  }), 201, "create oil");
  assert.equal(oil.stockLitres, 10);
  status(await request(`/job-cards/${jobId}/oils`, "other", "POST", { oilId: oil.id, litres: 4.5 }),
    403, "non-assigned technician cannot request");
  status(await request(`/job-cards/${jobId}/oils`, "tech", "POST", { oilId: oil.id, litres: 4.5001 }),
    400, "more than three decimal places");
  const reserved = status(await request(`/job-cards/${jobId}/oils`, "tech", "POST",
    { oilId: oil.id, litres: 4.5 }), 201, "assigned technician reserves 4.5 litres");
  status(await request(`/job-cards/${jobId}/oils`, "tech", "POST", { oilId: oil.id, litres: 6 }),
    422, "reservation cannot exceed available litres");
  const atRequest = status(await request("/parts/oils", "parts"), 200, "stock after request");
  assert.equal(atRequest[0].stockLitres, 10, "request does not deduct stock");
  const options = status(await request(`/job-cards/${jobId}/oils/catalog`, "tech"), 200, "tech oil catalogue");
  assert.equal(options[0].availableLitres, 5.5);
  assert.equal("purchaseCostPerLitre" in options[0], false, "cost hidden from technician");
  status(await request(`/job-cards/${jobId}/oils/${reserved.id}/issue`, "parts", "POST", { litres: 4.5 }),
    422, "cannot issue without approval");
  status(await request(`/job-cards/${jobId}/oils/${reserved.id}/approve`, "parts", "POST", {}),
    200, "parts approval");
  status(await request(`/job-cards/${jobId}/oils/${reserved.id}/issue`, "tech", "POST", { litres: 4.5 }),
    403, "technician cannot issue own request");
  status(await request(`/job-cards/${jobId}/oils/${reserved.id}/issue`, "parts", "POST", { litres: 4.5 }),
    200, "parts issue");
  status(await request(`/job-cards/${jobId}/oils/${reserved.id}/issue`, "parts", "POST", { litres: 4.5 }),
    422, "duplicate issue rejected");
  const afterIssue = status(await request("/parts/oils", "parts"), 200, "stock after issue");
  assert.equal(afterIssue[0].stockLitres, 5.5);
  const wrongDealer = await request(`/job-cards/${jobId}/oils`, "tech", "GET", undefined, 1);
  assert.ok(wrongDealer.status === 403 || wrongDealer.status === 404, "foreign dealer rejected");
  const snapshot = await pool.query<{ quote_total: number; estimate_version: number }>(
    "SELECT quote_total,estimate_version FROM job_cards WHERE dealer_id=$1 AND id=$2",
    [dealerId, jobId],
  );
  assert.ok(Number(snapshot.rows[0]?.quote_total) >= 5555.52, "estimate includes issued oil");
  await pool.query("UPDATE job_cards SET status='completed' WHERE dealer_id=$1 AND id=$2", [dealerId, jobId]);
  status(await request(`/job-cards/${jobId}/invoice`, "manager", "POST", {}),
    422, "customer-pay invoice requires customer authorization");
  // Warranty work is not customer-chargeable; use it to verify invoice
  // mechanics without fabricating customer approval or sending customer mail.
  await pool.query("UPDATE job_cards SET pay_type='warranty' WHERE dealer_id=$1 AND id=$2", [dealerId, jobId]);
  const invoice = status(await request(`/job-cards/${jobId}/invoice`, "manager", "POST", {}),
    201, "synthetic warranty invoice");
  assert.equal(invoice.partsTotal, 5555.52);
  const invoiced = await pool.query<{ quantity_litres: string; amount: string }>(
    "SELECT quantity_litres,amount FROM workshop_invoice_oils WHERE dealer_id=$1 AND invoice_id=$2",
    [dealerId, invoice.id],
  );
  assert.equal(Number(invoiced.rows[0]?.quantity_litres), 4.5);
  assert.equal(Number(invoiced.rows[0]?.amount), 5555.52);
  status(await request(`/job-cards/${jobId}/invoice`, "manager", "POST", {}), 409, "duplicate invoice");
  const final = status(await request("/parts/oils", "parts"), 200, "stock after invoice");
  assert.equal(final[0].stockLitres, 5.5, "invoice did not deduct oil again");
  process.stdout.write(`Live HTTP oil journey passed on synthetic dealer ${dealerId}; cleaning fixtures.\n`);
} finally {
  await cleanup();
  await pool.end();
}