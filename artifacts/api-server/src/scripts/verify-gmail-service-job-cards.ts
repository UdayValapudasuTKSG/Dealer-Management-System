/**
 * Development-only Gmail booking/job-card regression. It never starts the
 * server or intake worker, never connects to IMAP, and removes its fixtures.
 */
import { strict as assert } from "node:assert";

function refuse(reason: string): never {
  console.error(`verify-gmail-service-job-cards refuses to run: ${reason}`);
  process.exit(1);
}

if (process.env.NODE_ENV !== "development") {
  refuse("NODE_ENV must be development.");
}
process.env.OUTBOX_WORKER_DISABLED = "1";
const rawDatabaseUrl = process.env.DATABASE_URL ?? process.env.DEV_DATABASE_URL;
if (!rawDatabaseUrl) refuse("DATABASE_URL or DEV_DATABASE_URL is not set.");
let databaseUrl: URL;
try {
  databaseUrl = new URL(rawDatabaseUrl);
} catch {
  refuse("The development database URL is not parseable.");
}
if (!new Set(["helium", "localhost", "127.0.0.1"]).has(databaseUrl.hostname.toLowerCase())) {
  refuse(`Database host "${databaseUrl.hostname}" is not allowlisted for development.`);
}
if (process.env.PROD_DATABASE_URL) {
  try {
    const production = new URL(process.env.PROD_DATABASE_URL);
    if (
      production.hostname === databaseUrl.hostname &&
      production.port === databaseUrl.port &&
      production.pathname === databaseUrl.pathname
    ) {
      refuse("The development database URL matches PROD_DATABASE_URL.");
    }
  } catch {
    // The strict host allowlist above remains authoritative.
  }
}

// Imports happen only after all production guards and worker-disable flags.
const { pool } = await import("@workspace/db");
const {
  createServiceBookingFromEmail,
  parseServiceBookingForm,
  repairMissingGmailServiceJobCards,
} = await import("../lib/gmail-intake");
const { isAgentEnabled } = await import("../lib/agent-governance");

const marker = `verify-gmail-card-${Date.now()}`;
const externalIds: string[] = [];
const orderIds: number[] = [];
const dealerIds: number[] = [];

async function insertOrder(dealerId: number, status: string, label: string) {
  const result = await pool.query<{ id: number }>(
    `insert into service_orders
       (dealer_id, vehicle_info, scheduled_date, status, complaint,
        estimated_hours, pay_type, type, created_origin)
     values ($1, $2, '2099-01-15', $3, $4, 2, 'customer', 'repair', 'system')
     returning id`,
    [dealerId, `${marker}-${label}`, status, `${marker} ${label}`],
  );
  const id = result.rows[0]!.id;
  orderIds.push(id);
  return id;
}

async function insertLedger(
  dealerId: number,
  orderId: number | null,
  label: string,
) {
  const externalId = `${marker}-${label}`;
  externalIds.push(externalId);
  await pool.query(
    `insert into webhook_events
       (dealer_id, channel, external_id, service_order_id)
     values ($1, 'gmail_email', $2, $3)`,
    [dealerId, externalId, orderId],
  );
}

try {
  const dealers = await pool.query<{ id: number }>(
    `select id from dealers
      where status = 'active'
        and coalesce((entitlements->>'ai_agents')::boolean, true)
        and coalesce((entitlements->>'gmail_intake')::boolean, true)
      order by id`,
  );
  assert.ok(dealers.rows.length >= 2, "suite needs two existing development dealers");
  const enabledDealer = (
    await Promise.all(
      dealers.rows.map(async ({ id }) => ({
        id,
        enabled: await isAgentEnabled(id, "intake_dedup"),
      })),
    )
  ).find((dealer) => dealer.enabled);
  assert.ok(enabledDealer, "suite needs an active dealer with Gmail intake governance enabled");
  const dealerA = enabledDealer.id;
  const dealerB = dealers.rows.find(({ id }) => id !== dealerA)!.id;

  const externalId = `${marker}-live`;
  externalIds.push(externalId);
  const email = `${marker}@example.invalid`;
  const text = `Name: Gmail Card Customer
Email: ${email}
Phone: +592 600 1234
Model: Toyota RAV4
Preferred Date: January 15, 2099
Wait for or drop off vehicle?: Drop off vehicle
Select one or more services below: Air conditioner; Oil change`;
  assert.deepEqual(
    parseServiceBookingForm({ text }).issues,
    [],
    "the regression fixture must be a valid service form",
  );
  const first = await createServiceBookingFromEmail({
    dealerId: dealerA,
    externalId,
    subject: "Website Contact Form | Book Your Service Online",
    text,
    html: null,
  });
  assert.ok(first, "new Gmail booking was not created");
  orderIds.push(first.orderId);

  const liveCards = await pool.query<{
    dealer_id: number;
    service_order_id: number;
    status: string;
    quoted_labor_hours: number;
    labor_hours: number;
    timer_seconds: number;
    timer_started_at: Date | null;
    scheduled_at: Date | null;
    quote_approved_at: Date | null;
    estimate_approval_at: Date | null;
    service_analysis: string | null;
    work_performed: string | null;
  }>(
    `select dealer_id, service_order_id, status, quoted_labor_hours,
            labor_hours, timer_seconds, timer_started_at, scheduled_at, quote_approved_at,
            estimate_approval_at, service_analysis, work_performed
       from job_cards where service_order_id = $1`,
    [first.orderId],
  );
  assert.equal(liveCards.rowCount, 1, "booking and canonical card were not committed together");
  const card = liveCards.rows[0]!;
  assert.equal(card.dealer_id, dealerA);
  assert.equal(card.status, "open");
  assert.equal(Number(card.labor_hours), 2);
  assert.equal(Number(card.quoted_labor_hours), 2);
  assert.equal(card.timer_seconds, 0);
  assert.equal(card.timer_started_at, null);
  assert.equal(card.scheduled_at, null, "an unconfirmed date must not invent a 09:00 appointment");
  assert.equal(card.quote_approved_at, null);
  assert.equal(card.estimate_approval_at, null);
  assert.equal(card.service_analysis, null);
  assert.equal(card.work_performed, null);

  const replay = await createServiceBookingFromEmail({
    dealerId: dealerA,
    externalId,
    subject: "Website Contact Form | Book Your Service Online",
    text,
    html: null,
  });
  assert.equal(replay, null, "dedupe replay created another booking");
  const replayCounts = await pool.query<{ orders: string; cards: string }>(
    `select
       (select count(*)::text from service_orders where id = $1) as orders,
       (select count(*)::text from job_cards where service_order_id = $1) as cards`,
    [first.orderId],
  );
  assert.deepEqual(replayCounts.rows[0], { orders: "1", cards: "1" });

  const catchupOrder = await insertOrder(dealerA, "open", "catchup");
  await insertLedger(dealerA, catchupOrder, "catchup");
  const terminalOrder = await insertOrder(dealerA, "closed", "terminal");
  await insertLedger(dealerA, terminalOrder, "terminal");
  const foreignOrder = await insertOrder(dealerA, "open", "foreign");
  await insertLedger(dealerB, foreignOrder, "foreign");
  await insertLedger(dealerA, null, "deleted-detached");

  assert.equal(
    await repairMissingGmailServiceJobCards(100, marker),
    1,
    "repair did not create exactly the eligible card",
  );
  const repaired = await pool.query<{ service_order_id: number }>(
    `select service_order_id from job_cards
      where service_order_id = any($1::int[]) order by service_order_id`,
    [[catchupOrder, terminalOrder, foreignOrder]],
  );
  assert.deepEqual(
    repaired.rows.map((row) => row.service_order_id),
    [catchupOrder],
    "repair crossed dealer scope or included terminal/deleted bookings",
  );

  // Hold an uncommitted terminal transition after the candidate snapshot is
  // readable. The repair must wait, lock, and reject the now-closed parent.
  const raceOrder = await insertOrder(dealerA, "open", "terminal-race");
  await insertLedger(dealerA, raceOrder, "terminal-race");
  const pausedDealer = await pool.query<{ id: number }>(
    "insert into dealers (name, status) values ($1, 'suspended') returning id",
    [`${marker}-paused-dealer`],
  );
  const pausedDealerId = pausedDealer.rows[0]!.id;
  dealerIds.push(pausedDealerId);
  const pausedOrder = await insertOrder(pausedDealerId, "open", "paused");
  await insertLedger(pausedDealerId, pausedOrder, "paused");
  const blocker = await pool.connect();
  try {
    await blocker.query("begin");
    await blocker.query("update service_orders set status = 'closed' where id = $1", [
      raceOrder,
    ]);
    const racedRepair = repairMissingGmailServiceJobCards(100, `${marker}-terminal-race`);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await blocker.query("commit");
    assert.equal(await racedRepair, 0, "stale candidate resurrected a closed booking");
  } finally {
    blocker.release();
  }
  assert.equal(
    await repairMissingGmailServiceJobCards(100, marker),
    0,
    "repair retry created an extra card",
  );
  const excluded = await pool.query<{ id: number }>(
    "select id from job_cards where service_order_id = any($1::int[])",
    [[raceOrder, pausedOrder]],
  );
  assert.equal(excluded.rowCount, 0, "terminal-race or paused-dealer card was created");

  console.log("Gmail service booking job-card DB regression passed");
} finally {
  if (orderIds.length > 0) {
    await pool.query(
      "delete from agent_runs where ref_type = 'service_order' and ref_id = any($1::int[])",
      [orderIds],
    );
    await pool.query(
      "delete from notifications where link = any($1::text[])",
      [orderIds.map((id) => `/service?order=${id}`)],
    );
  }
  if (orderIds.length > 0) {
    await pool.query("delete from job_cards where service_order_id = any($1::int[])", [
      orderIds,
    ]);
  }
  if (externalIds.length > 0) {
    await pool.query(
      "delete from webhook_events where channel = 'gmail_email' and external_id = any($1::text[])",
      [externalIds],
    );
  }
  if (orderIds.length > 0) {
    await pool.query("delete from service_orders where id = any($1::int[])", [
      orderIds,
    ]);
  }
  await pool.query(
    "delete from customers where email like $1 and not exists (select 1 from service_orders where service_orders.customer_id = customers.id)",
    [`${marker}%`],
  );
  if (dealerIds.length > 0) {
    await pool.query("delete from dealers where id = any($1::int[])", [dealerIds]);
  }
  await pool.end();
}