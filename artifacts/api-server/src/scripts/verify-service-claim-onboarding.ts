/**
 * Development-only, destructive-but-isolated HTTP verification. Requires the
 * already-running local API and App Storage; it never creates an email invite.
 */
import { createHash, randomBytes } from "node:crypto";
import { pool } from "@workspace/db";
import { ObjectStorageService } from "../lib/objectStorage";

const databaseUrl = process.env.DATABASE_URL ?? "";
if (process.env.NODE_ENV === "production" ||
  (process.env.PROD_DATABASE_URL && databaseUrl === process.env.PROD_DATABASE_URL)) {
  throw new Error("Refusing service/onboarding verification against production");
}
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const base = "http://localhost:8080/api";
const storage = new ObjectStorageService();
const marker = `verify-sco-${Date.now()}-${randomBytes(4).toString("hex")}`;
const objectPaths: string[] = [];
let customerId = 0;
let orderIds: number[] = [];
let requestIds: number[] = [];

function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
async function api(path: string, email: string | null, init: RequestInit = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-dealer-id": "1",
      ...(email ? { "x-test-user-email": email } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { response, body };
}
const token = () => randomBytes(32).toString("base64url");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  const personas = await pool.query<{ email: string; role: string }>(
    `select u.email, r.name role from dealer_users du
       join users u on u.id=du.user_id join roles r on r.id=du.role_id
     where du.dealer_id=1 and r.name in ('Technician','General Manager')
       and u.status='active' and u.email is not null`,
  );
  const tech = personas.rows.find((row) => row.role === "Technician")?.email;
  const gm = personas.rows.find((row) => row.role === "General Manager")?.email;
  assert(tech && gm, "dealer-1 Technician and General Manager personas are required");

  const customer = await pool.query<{ id: number }>(
    `insert into customers (dealer_id,name,email) values (1,$1,$2) returning id`,
    [`${marker} Customer`, `${marker}@example.invalid`],
  );
  customerId = customer.rows[0]!.id;
  async function fixtureOrder(label: string) {
    const order = await pool.query<{ id: number }>(
      `insert into service_orders (dealer_id,customer_id,customer_name,vehicle_info,scheduled_date,status)
       values (1,$1,$2,$3,current_date,'acknowledged') returning id`,
      [customerId, `${marker} Customer`, `${label} vehicle`],
    );
    const id = order.rows[0]!.id; orderIds.push(id);
    const card = await pool.query<{ id: number }>(
      `insert into job_cards (dealer_id,service_order_id,title,status) values (1,$1,$2,'open') returning id`,
      [id, label],
    );
    return { orderId: id, cardId: card.rows[0]!.id };
  }

  const first = await fixtureOrder(`${marker} first`);
  const listed = await api("/service-orders", tech);
  assert(listed.response.status === 200 && listed.body.some((row: any) => row.id === first.orderId),
    "technician cannot see unassigned service order");
  const cardList = await api("/job-cards", tech);
  assert(cardList.response.status === 200 && cardList.body.some((row: any) => row.id === first.cardId),
    "technician cannot see unassigned job card");
  const deniedPatch = await api(`/job-cards/${first.cardId}`, tech, {
    method: "PATCH", body: JSON.stringify({ notes: "must not mutate" }),
  });
  assert(deniedPatch.response.status === 403, "unassigned technician PATCH was not denied");
  const claimed = await api(`/service-orders/${first.orderId}/claim`, tech, { method: "POST", body: "{}" });
  assert(claimed.response.status === 200 && claimed.body.assignedJobCardCount >= 1, "technician self-claim failed");
  const competed = await api(`/service-orders/${first.orderId}/claim`, gm, { method: "POST", body: "{}" });
  assert(competed.response.status === 409, "competing claim did not return 409");

  const second = await fixtureOrder(`${marker} second`);
  const gmAssign = await api(`/service-orders/${second.orderId}/claim`, gm, {
    method: "POST", body: JSON.stringify({ technicianUserId: claimed.body.serviceOrder.technicianUserId }),
  });
  assert(gmAssign.response.status === 200, "GM eligible technician assignment failed");
  const techReassign = await api(`/service-orders/${second.orderId}/claim`, tech, {
    method: "POST", body: JSON.stringify({ technicianUserId: 999999 }),
  });
  assert(techReassign.response.status === 409 || techReassign.response.status === 403,
    "technician could assign another user");

  const lifecycle = await fixtureOrder(`${marker} lifecycle`);
  const lifecycleClaim = await api(`/service-orders/${lifecycle.orderId}/claim`, tech, { method: "POST", body: "{}" });
  assert(lifecycleClaim.response.status === 200, "lifecycle card claim failed");
  const start = await api(`/job-cards/${lifecycle.cardId}`, tech, {
    method: "PATCH", body: JSON.stringify({ status: "in_progress" }),
  });
  assert(start.response.status === 200, "open->in_progress failed");
  await sleep(200);
  const started = await pool.query<{ count: string }>(
    `select count(*) from email_logs where dealer_id=1 and customer_id=$1 and template='service.started'`, [customerId],
  );
  const ack = await pool.query<{ count: string }>(
    `select count(*) from email_logs where dealer_id=1 and customer_id=$1 and template='service.booking.confirmed'`, [customerId],
  );
  assert(Number(started.rows[0]!.count) === 1 && Number(ack.rows[0]!.count) === 0,
    "job-card lifecycle email dedupe/acknowledgement invariant failed");
  const complete = await api(`/job-cards/${lifecycle.cardId}`, tech, {
    method: "PATCH", body: JSON.stringify({ status: "completed", serviceAnalysis: "verified", workPerformed: "completed" }),
  });
  assert(complete.response.status === 200, "completion with write-up failed");
  await sleep(200);
  const resolved = await pool.query<{ status: string }>(`select status from service_orders where id=$1`, [lifecycle.orderId]);
  const ready = await pool.query<{ count: string }>(
    `select count(*) from email_logs where dealer_id=1 and customer_id=$1 and template='vehicle_ready'`, [customerId],
  );
  assert(resolved.rows[0]?.status === "resolved" && Number(ready.rows[0]!.count) === 1,
    "completion did not resolve/order-ready exactly once");

  const validToken = token(), expiredToken = token(), submittedToken = token();
  const inserts = await pool.query<{ id: number }>(
    `insert into vehicle_onboarding_requests (dealer_id,customer_id,token_hash,expires_at,submitted_at)
     values (1,$1,$2,now()+interval '1 hour',null),(1,$1,$3,now()-interval '1 hour',null),(1,$1,$4,now()+interval '1 hour',now())
     returning id`,
    [customerId, hash(validToken), hash(expiredToken), hash(submittedToken)],
  );
  requestIds = inserts.rows.map((row) => row.id);
  assert((await api(`/vehicle-onboarding/${validToken}`, null)).body.state === "open", "valid onboarding state failed");
  assert((await api(`/vehicle-onboarding/${expiredToken}`, null)).body.state === "expired", "expired onboarding state failed");
  assert((await api(`/vehicle-onboarding/${submittedToken}`, null)).body.state === "submitted", "submitted onboarding state failed");
  assert((await api(`/vehicle-onboarding/${token()}`, null)).response.status === 404, "invalid onboarding token leaked");
  const badMime = await api(`/vehicle-onboarding/${validToken}/media/upload-url`, null, {
    method: "POST", body: JSON.stringify({ kind: "image", mimeType: "application/pdf" }),
  });
  assert(badMime.response.status === 422, "unsupported onboarding MIME accepted");
  async function upload(kind: "image" | "video", mimeType: string, bytes: Uint8Array, expect = 200) {
    const created = await api(`/vehicle-onboarding/${validToken}/media/upload-url`, null, {
      method: "POST", body: JSON.stringify({ kind, mimeType, originalName: `${kind}.${kind === "image" ? "jpg" : "mp4"}` }),
    });
    assert(created.response.status === 201, `could not create ${kind} upload`);
    const put = await fetch(created.body.uploadUrl, { method: "PUT", headers: { "content-type": mimeType }, body: bytes });
    assert(put.ok, `${kind} storage PUT failed`);
    const finalized = await api(`/vehicle-onboarding/${validToken}/media/${created.body.mediaId}/finalize`, null, { method: "POST", body: "{}" });
    assert(finalized.response.status === expect, `${kind} finalize expected ${expect}, got ${finalized.response.status}`);
    return created.body.mediaId as number;
  }
  const imageId = await upload("image", "image/jpeg", new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
  const videoId = await upload("video", "video/mp4", new Uint8Array([0, 0, 0, 20, 102, 116, 121, 112]));
  const read = await fetch(`${base}/vehicle-onboarding/${validToken}/media/${imageId}`);
  assert(read.status === 200, "valid token-bound media read failed");
  await upload("image", "image/jpeg", new Uint8Array(15 * 1024 * 1024 + 1), 422);
  const submit = await api(`/vehicle-onboarding/${validToken}/submit`, null, {
    method: "POST", body: JSON.stringify({ registration: marker, make: "Verify", model: "Garage", mileage: 1 }),
  });
  assert(submit.response.status === 201, "onboarding submit failed");
  assert((await api(`/vehicle-onboarding/${validToken}/submit`, null, {
    method: "POST", body: JSON.stringify({ registration: marker, make: "Verify", model: "Garage" }),
  })).response.status === 409, "onboarding single-submit CAS failed");
  const bound = await pool.query<{ count: string }>(
    `select count(*) from vehicle_onboarding_media m join garage_vehicles g on g.id=m.garage_vehicle_id
     where m.request_id=$1 and m.dealer_id=1 and m.customer_id=$2 and g.dealer_id=1 and g.customer_id=$2 and m.finalized_at is not null`,
    [requestIds[0], customerId],
  );
  assert(Number(bound.rows[0]!.count) === 2, "finalized onboarding media is not bound to garage vehicle/request");
  await pool.query(`update vehicle_onboarding_requests set expires_at=now()-interval '1 second' where id=$1`, [requestIds[0]]);
  assert((await fetch(`${base}/vehicle-onboarding/${validToken}/media/${videoId}`)).status === 410,
    "expired token streamed private media");
  console.log("service claim + vehicle onboarding verification passed");
} finally {
  try {
    const media = await pool.query<{ object_path: string }>(
      `select object_path from vehicle_onboarding_media where customer_id=$1`, [customerId],
    );
    objectPaths.push(...media.rows.map((row) => row.object_path));
    for (const path of objectPaths) {
      try { await storage.getObjectEntityFile(path).then((file) => file.delete()); } catch { /* best effort cleanup */ }
    }
    if (customerId) {
      await pool.query(`delete from email_logs where customer_id=$1`, [customerId]);
      await pool.query(`delete from vehicle_onboarding_media where customer_id=$1`, [customerId]);
      await pool.query(`delete from vehicle_onboarding_requests where customer_id=$1`, [customerId]);
      await pool.query(`delete from garage_vehicles where customer_id=$1`, [customerId]);
      await pool.query(`delete from job_cards where service_order_id = any($1::int[])`, [orderIds]);
      await pool.query(`delete from service_orders where id = any($1::int[])`, [orderIds]);
      await pool.query(`delete from customers where id=$1`, [customerId]);
    }
  } finally { await pool.end(); }
}