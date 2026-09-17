/**
 * Task 304 — workshop carryover and customer approval regression suite.
 *
 * This is deliberately an opt-in, development-only HTTP verification. It
 * seeds a unique dealer, users and workshop rows, and deletes only rows which
 * carry that dealer id during cleanup. Customer fixtures have no email and use
 * a reserved-looking test phone only because booking validation requires one;
 * the outbox worker is disabled before any application import.
 *
 * Start a local API pointed at the same opted-in development database, then:
 *   pnpm --filter @workspace/api-server verify:workshop-carryover
 *
 * The assertions cover WIP dealer-day boundaries and export parity, waiting /
 * rollover timer safety, booking provenance, parts-credit concurrency and
 * post-issue adjustments, plus estimate version decision security.
 */
import { createHash, randomBytes } from "node:crypto";

export {};

function refuse(reason: string): never {
  throw new Error(`verify-workshop-carryover-customer-approval refuses to run: ${reason}`);
}

// Keep this preflight above the dynamic DB import. A verification fixture must
// never even initialize a pool against an unapproved database target.
if (process.env.VERIFY_WORKSHOP_CARRYOVER_DB !== "1") {
  refuse("set VERIFY_WORKSHOP_CARRYOVER_DB=1 to opt in to fixture writes");
}
if (process.env.NODE_ENV === "production") {
  refuse("NODE_ENV=production");
}
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.OUTBOX_WORKER_DISABLED = "1";

const databaseUrl = process.env.DATABASE_URL ?? process.env.DEV_DATABASE_URL;
if (!databaseUrl) refuse("DATABASE_URL or DEV_DATABASE_URL is required");
let databaseHost: string;
try {
  databaseHost = new URL(databaseUrl).hostname.toLowerCase();
} catch {
  refuse("database URL is not parseable");
}
const safeHosts = new Set(["helium", "localhost", "127.0.0.1"]);
if (
  process.env.PGHOST &&
  ["helium", "localhost", "127.0.0.1"].includes(process.env.PGHOST.toLowerCase())
) {
  safeHosts.add(process.env.PGHOST.toLowerCase());
}
if (!safeHosts.has(databaseHost)) {
  refuse(`database host "${databaseHost}" is not an allowlisted development host`);
}
if (process.env.PROD_DATABASE_URL) {
  try {
    const prod = new URL(process.env.PROD_DATABASE_URL);
    const target = new URL(databaseUrl);
    if (prod.hostname === target.hostname && prod.pathname === target.pathname) {
      refuse("database target matches PROD_DATABASE_URL");
    }
  } catch {
    // A malformed production URL cannot weaken the strict host allowlist.
  }
}

const apiBase = process.env.VERIFY_API_BASE ?? "http://localhost:8080/api";
let apiHost: string;
try {
  apiHost = new URL(apiBase).hostname.toLowerCase();
} catch {
  refuse("VERIFY_API_BASE is not a parseable URL");
}
if (!["localhost", "127.0.0.1", "::1"].includes(apiHost)) {
  refuse("VERIFY_API_BASE must be loopback so dev-only persona headers stay local");
}

// Only now is it safe to load anything which can create a DB connection.
const { pool, db, jobCardsTable, serviceOrdersTable } = await import("@workspace/db");
const { and, eq } = await import("drizzle-orm");
const { hasCurrentChargeableWorkAuthorization } = await import("../lib/service-estimate-gate");
const { renderEmail } = await import("../lib/email");
const { preflightEmailRecipient } = await import("../lib/email");
const { queueServiceEstimateQuote } = await import("../lib/email-triggers");
const { encryptSmtpPassword } = await import("../lib/smtp-crypto");
// The acknowledgement columns are intentionally applied only by this
// already-allowlisted, opt-in development verifier. Production migrations
// remain the deployment owner's responsibility.
const { readFile } = await import("node:fs/promises");
const staffAcknowledgementMigration = await readFile(
  new URL(
    "../../../../lib/db/migrations/2026-09-26-job-card-estimate-staff-acknowledgement.sql",
    import.meta.url,
  ),
  "utf8",
);
await pool.query(staffAcknowledgementMigration);

const marker = `verify-wca-${Date.now()}-${randomBytes(5).toString("hex")}`;
const token = () => randomBytes(32).toString("base64url");
const tokenHash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const assertionFailures: string[] = [];

function assert(value: unknown, message: string): asserts value {
  if (!value) assertionFailures.push(message);
}
function equal<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    assertionFailures.push(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}
function dayKeyInZone(timeZone: string, offset = 0): string {
  const pieces = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) => pieces.find((part) => part.type === type)?.value;
  const date = new Date(Date.UTC(Number(get("year")), Number(get("month")) - 1, Number(get("day"))));
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}
function rowNumber(row: Record<string, unknown>, key: string): number {
  const value = Number(row[key]);
  assert(Number.isFinite(value), `expected numeric ${key} on response row`);
  return value;
}
function responseDay(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)
    ? value.slice(0, 10)
    : null;
}

type ApiResult = { response: Response; body: any; text: string };
async function api(
  path: string,
  email: string | null,
  dealerId: number,
  init: RequestInit = {},
): Promise<ApiResult> {
  const response = await fetch(`${apiBase.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      "x-dealer-id": String(dealerId),
      ...(email ? { "x-test-user-email": email } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body, text };
}
function expectStatus(result: ApiResult, status: number, message: string): void {
  if (result.response.status !== status) {
    throw new Error(
      `${message}: expected HTTP ${status}, got ${result.response.status}; ${result.text.slice(0, 600)}`,
    );
  }
}
function responseRows(result: ApiResult, message: string): any[] {
  assert(Array.isArray(result.body), `${message}: expected an array response`);
  return result.body;
}

// Keep the pure shared gate's truth table alongside HTTP coverage so a future
// route cannot accidentally reinterpret a nullable acknowledgement field.
const authorizationMatrix: Array<{
  name: string;
  card: Parameters<typeof hasCurrentChargeableWorkAuthorization>[0];
  expected: boolean;
}> = [
  { name: "neither", card: { payType: "customer", quoteTotal: 114, estimateVersion: 1, estimateApprovedVersion: null, estimateStaffAcknowledgedVersion: null, estimateStaffAcknowledgedDecisionId: null }, expected: false },
  { name: "customerOnly", card: { payType: "customer", quoteTotal: 114, estimateVersion: 1, estimateApprovedVersion: 1, estimateStaffAcknowledgedVersion: null, estimateStaffAcknowledgedDecisionId: null }, expected: false },
  { name: "ackOnly", card: { payType: "customer", quoteTotal: 114, estimateVersion: 1, estimateApprovedVersion: null, estimateStaffAcknowledgedVersion: 1, estimateStaffAcknowledgedDecisionId: 9 }, expected: false },
  { name: "bothCurrent", card: { payType: "customer", quoteTotal: 114, estimateVersion: 1, estimateApprovedVersion: 1, estimateStaffAcknowledgedVersion: 1, estimateStaffAcknowledgedDecisionId: 9 }, expected: true },
  { name: "staleAck", card: { payType: "customer", quoteTotal: 114, estimateVersion: 2, estimateApprovedVersion: 2, estimateStaffAcknowledgedVersion: 1, estimateStaffAcknowledgedDecisionId: 9 }, expected: false },
  { name: "zeroCost", card: { payType: "customer", quoteTotal: 0, estimateVersion: 1, estimateApprovedVersion: null, estimateStaffAcknowledgedVersion: null, estimateStaffAcknowledgedDecisionId: null }, expected: true },
  { name: "warranty", card: { payType: "warranty", quoteTotal: 114, estimateVersion: 1, estimateApprovedVersion: null, estimateStaffAcknowledgedVersion: null, estimateStaffAcknowledgedDecisionId: null }, expected: true },
];
for (const scenario of authorizationMatrix) {
  equal(
    hasCurrentChargeableWorkAuthorization(scenario.card),
    scenario.expected,
    `chargeable-work authorization matrix ${scenario.name}`,
  );
}

let dealerId = 0;
let otherDealerId = 0;
let managerUserId = 0;
let technicianUserId = 0;
let customerId = 0;
let partId = 0;

async function cleanup(): Promise<void> {
  if (!dealerId && !otherDealerId) return;
  // Newer schema versions may add a dedicated adjustment ledger. The
  // canonical invoice JSON is removed with service_invoices below; this
  // optional cleanup keeps the script compatible with either implementation.
  for (const id of [dealerId, otherDealerId].filter(Boolean)) {
    await pool.query(`delete from smtp_connections where dealer_id = $1`, [id]);
    await pool.query(`delete from external_job_card_parts where dealer_id = $1`, [id]);
    await pool.query(`delete from part_requisition_fulfillments where dealer_id = $1`, [id]);
    await pool.query(`delete from part_requisition_po_allocations where dealer_id = $1`, [id]);
    await pool.query(`delete from part_requisition_lines where dealer_id = $1`, [id]);
    await pool.query(`delete from part_requisitions where dealer_id = $1`, [id]);
    await pool.query(`delete from purchase_order_receipt_lines where dealer_id = $1`, [id]);
    await pool.query(`delete from purchase_order_receipts where dealer_id = $1`, [id]);
    await pool.query(`delete from purchase_order_lines where dealer_id = $1`, [id]);
    await pool.query(`delete from purchase_orders where dealer_id = $1`, [id]);
    await pool.query(`delete from erpnext_sync_jobs where dealer_id = $1`, [id]);
    await pool.query(`delete from email_logs where dealer_id = $1`, [id]);
    await pool.query(`delete from leads where dealer_id = $1`, [id]);
    await pool.query(`delete from service_estimate_decisions where dealer_id = $1`, [id]);
    await pool.query(`delete from part_credit_notes where dealer_id = $1`, [id]);
    await pool.query(`delete from job_card_parts where dealer_id = $1`, [id]);
    await pool.query(`delete from collision_claims where dealer_id = $1`, [id]);
    await pool.query(`delete from service_invoices where dealer_id = $1`, [id]);
    await pool.query(`delete from job_cards where dealer_id = $1`, [id]);
    // Job-card deletion may close a live timer, which appends a ledger row.
    // Remove only this verifier's rows through the trigger's transaction-local
    // maintenance mode after those closure entries have been written.
    const ledgerClient = await pool.connect();
    try {
      await ledgerClient.query("begin");
      await ledgerClient.query(
        "select set_config('app.technician_work_segment_ledger_maintenance', 'on', true)",
      );
      await ledgerClient.query(
        "delete from technician_work_segment_ledger where dealer_id = $1",
        [id],
      );
      await ledgerClient.query("commit");
    } catch (error) {
      await ledgerClient.query("rollback");
      throw error;
    } finally {
      ledgerClient.release();
    }
    await pool.query(`delete from service_orders where dealer_id = $1`, [id]);
    await pool.query(`delete from parts where dealer_id = $1`, [id]);
    await pool.query(`delete from suppliers where dealer_id = $1`, [id]);
    await pool.query(`delete from customers where dealer_id = $1`, [id]);
  }
  if (managerUserId || technicianUserId) {
    await pool.query(
      `delete from dealer_users where user_id = any($1::int[])`,
      [[managerUserId, technicianUserId].filter(Boolean)],
    );
    await pool.query(
      `delete from users where id = any($1::int[])`,
      [[managerUserId, technicianUserId].filter(Boolean)],
    );
  }
  for (const id of [dealerId, otherDealerId].filter(Boolean)) {
    await pool.query(`delete from dealers where id = $1`, [id]);
  }
}

try {
  const roles = await pool.query<{ id: number; name: string }>(
    `select id, name from roles where name in ('General Manager', 'Technician')`,
  );
  const managerRole = roles.rows.find((row) => row.name === "General Manager");
  const technicianRole = roles.rows.find((row) => row.name === "Technician");
  assert(managerRole && technicianRole, "General Manager and Technician roles are required");

  const dealer = await pool.query<{ id: number }>(
    `insert into dealers (name, status, timezone, entitlements)
     values ($1, 'active', 'America/Guyana', '{}'::jsonb) returning id`,
    [`${marker} Dealer`],
  );
  dealerId = dealer.rows[0]!.id;
  const otherDealer = await pool.query<{ id: number }>(
    `insert into dealers (name, status, timezone, entitlements)
     values ($1, 'active', 'America/Guyana', '{}'::jsonb) returning id`,
    [`${marker} Foreign dealer`],
  );
  otherDealerId = otherDealer.rows[0]!.id;

  const managerEmail = `${marker}-manager@example.invalid`;
  const technicianEmail = `${marker}-tech@example.invalid`;
  const users = await pool.query<{ id: number; email: string }>(
    `insert into users (clerk_id, email, name, role_id, status)
     values ($1, $2, $3, $4, 'active'), ($5, $6, $7, $8, 'active')
     returning id, email`,
    [
      `${marker}-manager`,
      managerEmail,
      `${marker} Manager`,
      managerRole.id,
      `${marker}-tech`,
      technicianEmail,
      `${marker} Technician`,
      technicianRole.id,
    ],
  );
  managerUserId = users.rows.find((row) => row.email === managerEmail)!.id;
  technicianUserId = users.rows.find((row) => row.email === technicianEmail)!.id;
  await pool.query(
    `insert into dealer_users (dealer_id, user_id, role_id, is_general_manager)
     values ($1, $2, $3, true), ($1, $4, $5, false)`,
    [dealerId, managerUserId, managerRole.id, technicianUserId, technicianRole.id],
  );

  const customer = await pool.query<{ id: number }>(
    `insert into customers (dealer_id, name, phone) values ($1, $2, '+592 555 0100') returning id`,
    [dealerId, `${marker} Customer`],
  );
  customerId = customer.rows[0]!.id;
  const part = await pool.query<{ id: number }>(
    `insert into parts (dealer_id, sku, name, stock, reorder_level, unit_price, unit_cost, status)
     values ($1, $2, $3, 10, 0, 100, 50, 'active') returning id`,
    [dealerId, `${marker}-PART`, `${marker} wrong part`],
  );
  partId = part.rows[0]!.id;

  const today = dayKeyInZone("America/Guyana");
  const yesterday = dayKeyInZone("America/Guyana", -1);
  const twoDaysAgo = dayKeyInZone("America/Guyana", -2);
  const tomorrow = dayKeyInZone("America/Guyana", 1);
  // The workshop estimate/invoice source of truth is tax-inclusive. Seed the
  // single service-applicable VAT rule explicitly, rather than relying on
  // lazy defaults or allowing fixtures to accidentally test pre-tax totals.
  await pool.query(
    `insert into dealer_taxes
       (dealer_id, name, code, kind, rate, effective_from, active, sort_order, created_by)
     values ($1, 'VAT', 'vat', 'percent', 14, $2, true, 0, 'verification')`,
    [dealerId, today],
  );

  // Booking creation must stamp authenticated provenance and must never trust
  // a client-supplied origin. This also exercises the user-visible API shape.
  const created = await api("/service-orders", managerEmail, dealerId, {
    method: "POST",
    body: JSON.stringify({
      customerId,
      customerName: `${marker} Customer`,
      vehicleInfo: `${marker} Provenance vehicle`,
      vin: `${marker}-VIN`,
      registrationNumber: `${marker}-REG`,
      type: "repair",
      scheduledDate: today,
      complaint: "Regression provenance fixture",
      estimatedCost: 0,
      estimatedHours: 1,
      createdOrigin: "import",
    }),
  });
  expectStatus(created, 201, "booking creation");
  const createdProvenance = await pool.query<{
    created_by_user_id: number | null;
    created_by_name: string | null;
    created_origin: string;
  }>(
    `select created_by_user_id, created_by_name, created_origin
       from service_orders where id=$1 and dealer_id=$2`,
    [created.body.id, dealerId],
  );
  equal(createdProvenance.rows[0]?.created_by_user_id, managerUserId, "booking creator id is authenticated actor");
  equal(createdProvenance.rows[0]?.created_by_name, `${marker} Manager`, "booking creator name is immutable actor");
  equal(createdProvenance.rows[0]?.created_origin, "staff", "client cannot forge booking origin");
  const autoCreatedCard = await pool.query<{
    quote_total: number;
    labor_hours: number;
    labor_rate: number;
    status: string;
    waiting_reason: string | null;
  }>(
    `select quote_total, labor_hours, labor_rate, status, waiting_reason
       from job_cards where service_order_id=$1 and dealer_id=$2`,
    [created.body.id, dealerId],
  );
  equal(autoCreatedCard.rows[0]?.labor_hours, 1,
    "automatic job-card creation lost planned labour hours");
  equal(autoCreatedCard.rows[0]?.labor_rate, 120,
    "automatic job-card creation did not persist its canonical labour rate");
  equal(autoCreatedCard.rows[0]?.quote_total, 136.8,
    "automatic job-card creation did not persist labour plus configured VAT");
  equal(autoCreatedCard.rows[0]?.status, "on_hold",
    "automatic positive customer job card did not wait for estimate decision");
  equal(autoCreatedCard.rows[0]?.waiting_reason, "customer_decision",
    "automatic positive customer job card did not record quote waiting reason");

  // A deliberately old "legacy" booking retains the honest migration label.
  const legacyOrder = await pool.query<{ id: number }>(
    `insert into service_orders
       (dealer_id, customer_id, customer_name, vehicle_info, scheduled_date, status, created_origin, created_at)
     values ($1, $2, $3, $4, $5, 'acknowledged', 'legacy_unknown', now() - interval '7 days')
     returning id`,
    [dealerId, customerId, `${marker} Customer`, `${marker} Legacy vehicle`, twoDaysAgo],
  );
  const legacyListed = await api(`/service-orders?from=${twoDaysAgo}&to=${today}`, managerEmail, dealerId);
  expectStatus(legacyListed, 200, "booking list with legacy provenance");
  const legacyRow = responseRows(legacyListed, "booking list").find((row) => row.id === legacyOrder.rows[0]!.id);
  equal(legacyRow?.createdOrigin, "legacy_unknown", "legacy provenance stays explicit");
  assert(!legacyRow?.createdByName, "legacy unknown creator must not be fabricated");

  async function orderAndCard(opts: {
    label: string;
    scheduledDate: string;
    createdDaysAgo?: number;
    receivedDaysAgo?: number;
    status?: string;
    waitingReason?: string | null;
    technician?: boolean;
    timerRunning?: boolean;
    quoteTotal?: number;
    intake?: Record<string, unknown> | null;
  }): Promise<{ orderId: number; cardId: number }> {
    const age = opts.createdDaysAgo ?? 0;
    const order = await pool.query<{ id: number }>(
      `insert into service_orders
         (dealer_id, customer_id, customer_name, vehicle_info, scheduled_date, status, created_origin, created_at)
       values ($1, $2, $3, $4, $5, 'acknowledged', 'system', now() - ($6::text || ' days')::interval)
       returning id`,
      [dealerId, customerId, `${marker} Customer`, `${marker} ${opts.label}`, opts.scheduledDate, age],
    );
    const card = await pool.query<{ id: number }>(
      `insert into job_cards
        (dealer_id, service_order_id, title, status, technician_user_id, technician_name,
         scheduled_at, quote_total, labor_hours, labor_rate, waiting_reason, next_action,
         follow_up_date, waiting_history, intake, received_at, created_at, started_at, timer_seconds, timer_started_at)
       values
        ($1, $2, $3, $4, $5, $6, now() - ($7::text || ' days')::interval,
         $8, 0, 100, $9, $10, $11, $12::jsonb, $13::jsonb,
          now() - ($14::text || ' days')::interval,
         now() - ($7::text || ' days')::interval,
         now() - ($7::text || ' days')::interval, 90,
          case when $15 then now() - interval '2 minutes' else null end)
       returning id`,
      [
        dealerId,
        order.rows[0]!.id,
        opts.label,
        opts.status ?? "open",
        opts.technician === false ? null : technicianUserId,
        opts.technician === false ? null : `${marker} Technician`,
        age,
        opts.quoteTotal ?? 0,
        opts.waitingReason ?? null,
        opts.waitingReason ? "Awaiting regression follow-up" : null,
        opts.waitingReason ? tomorrow : null,
        JSON.stringify(opts.waitingReason ? [{
          action: "hold",
          reason: opts.waitingReason,
          nextAction: "Awaiting regression follow-up",
          followUpDate: tomorrow,
          byUserId: technicianUserId,
          byName: `${marker} Technician`,
          at: new Date().toISOString(),
        }] : []),
        JSON.stringify(opts.intake ?? null),
         opts.receivedDaysAgo ?? age,
         opts.timerRunning ?? false,
      ],
    );
    return { orderId: order.rows[0]!.id, cardId: card.rows[0]!.id };
  }

  // Sending an itemized quote is explicit and durable: a missing customer
  // recipient must be surfaced before the route invalidates/versions a quote.
  const missingRecipientQuote = await orderAndCard({
    label: "Missing estimate recipient vehicle",
    scheduledDate: today,
    status: "in_progress",
    quoteTotal: 114,
  });
  await pool.query(
    `update job_cards set labor_hours=1, labor_rate=100
       where id=$1 and dealer_id=$2`,
    [missingRecipientQuote.cardId, dealerId],
  );
  const missingRecipientSend = await api(
    `/job-cards/${missingRecipientQuote.cardId}/estimate/resend`,
    managerEmail,
    dealerId,
    { method: "POST" },
  );
  equal(missingRecipientSend.response.status, 422,
    "Send Quote falsely succeeded without a customer email recipient");
  const unchangedMissingRecipientQuote = await pool.query<{ estimate_version: number }>(
    `select estimate_version from job_cards where id=$1 and dealer_id=$2`,
    [missingRecipientQuote.cardId, dealerId],
  );
  equal(unchangedMissingRecipientQuote.rows[0]!.estimate_version, 0,
    "failed Send Quote invalidated/versioned a quote before preflight");
  await pool.query(
    `update customers set email=$1 where id=$2 and dealer_id=$3`,
    [`${marker}-customer@example.invalid`, customerId, dealerId],
  );
  // Recipient suppression is preflight-only: it must refuse the customer
  // communication without mutating any quote version, and needs no SMTP
  // transport or external address.
  await pool.query(
    `insert into leads (dealer_id, customer_id, name, email, email_opt_out)
     values ($1, $2, $3, $4, true)`,
    [dealerId, customerId, `${marker} Suppressed lead`, `${marker}-customer@example.invalid`],
  );
  const suppressedRecipientQuote = await orderAndCard({
    label: "Suppressed estimate recipient vehicle",
    scheduledDate: today,
    status: "open",
    quoteTotal: 114,
  });
  const suppressionPreflight = await preflightEmailRecipient(
    dealerId,
    `${marker}-customer@example.invalid`,
  );
  assert(!suppressionPreflight.ok && suppressionPreflight.code === "recipient_suppressed",
    "suppressed customer recipient passed estimate-email preflight");
  const suppressedQuoteVersion = await pool.query<{ estimate_version: number }>(
    `select estimate_version from job_cards where id=$1 and dealer_id=$2`,
    [suppressedRecipientQuote.cardId, dealerId],
  );
  equal(suppressedQuoteVersion.rows[0]!.estimate_version, 0,
    "recipient suppression changed a quote version");
  await pool.query(
    `delete from leads where dealer_id=$1 and customer_id=$2 and email_opt_out=true`,
    [dealerId, customerId],
  );

  // Exercise the atomic sender path directly, while the verifier-level worker
  // seam keeps this fake local SMTP connection from ever opening a socket.
  // The password is a deliberately non-secret fixture value encrypted by the
  // same helper used for a real dealer configuration.
  await pool.query(
    `insert into smtp_connections
       (dealer_id, host, port, security, username, password_ciphertext, from_email, from_name, enabled)
     values ($1, 'localhost', 2525, 'none', 'verification-user',
       $2, $3, $4, true)`,
    [
      dealerId,
      encryptSmtpPassword("verification-not-a-real-smtp-password", dealerId),
      `${marker}-sender@example.invalid`,
      `${marker} Dealer`,
    ],
  );
  // Match the workshop UI's manual job-card action: no caller supplies a
  // headline quote total. Positive labour must be canonicalized at creation,
  // exposed by the staff preview, and be sendable from its itemized breakdown.
  const realUiLabourOrder = await pool.query<{ id: number }>(
    `insert into service_orders
       (dealer_id, customer_id, customer_name, vehicle_info, scheduled_date, status, created_origin)
     values ($1, $2, $3, $4, $5, 'acknowledged', 'staff') returning id`,
    [
      dealerId,
      customerId,
      `${marker} Customer`,
      `${marker} Real UI labour vehicle`,
      today,
    ],
  );
  const realUiLabourCard = await api("/job-cards", managerEmail, dealerId, {
    method: "POST",
    body: JSON.stringify({
      serviceOrderId: realUiLabourOrder.rows[0]!.id,
      title: `${marker} Real UI labour card`,
      laborHours: 1,
      laborRate: 100,
      payType: "customer",
    }),
  });
  expectStatus(realUiLabourCard, 201, "real UI labour-only job-card creation");
  const realUiLabourCardId = Number(realUiLabourCard.body.id);
  assert(Number.isSafeInteger(realUiLabourCardId) && realUiLabourCardId > 0,
    "real UI labour-only job-card creation returned no id");
  const realUiLabourPreview = await api(
    `/job-cards/${realUiLabourCardId}/estimate/preview`,
    managerEmail,
    dealerId,
  );
  expectStatus(realUiLabourPreview, 200, "real UI labour-only estimate preview");
  equal(Number(realUiLabourPreview.body.total), 114,
    "real UI labour-only preview did not expose its canonical positive total");
  assert(
    Array.isArray(realUiLabourPreview.body.lines) &&
      realUiLabourPreview.body.lines.some((line: any) => line.kind === "labour" && line.amount === 100) &&
      realUiLabourPreview.body.lines.some((line: any) => line.kind === "tax" && line.amount === 14),
    "real UI labour-only preview did not expose canonical itemized terms",
  );
  const [realUiLabourCardRow] = await db.select().from(jobCardsTable).where(and(
    eq(jobCardsTable.id, realUiLabourCardId),
    eq(jobCardsTable.dealerId, dealerId),
  ));
  assert(realUiLabourCardRow,
    "real UI labour-only quote entities are missing");
  equal(realUiLabourCardRow?.quoteTotal, 114,
    "real UI labour-only creation did not persist canonical quote total");
  equal(realUiLabourCardRow?.status, "on_hold",
    "positive customer labour creation did not wait for an estimate decision");
  const realUiLabourQueued = await api(
    `/job-cards/${realUiLabourCardId}/estimate/resend`,
    managerEmail,
    dealerId,
    { method: "POST" },
  );
  expectStatus(realUiLabourQueued, 202,
    "real UI labour-only Send Quote action");
  equal(realUiLabourQueued.body?.outcome, "queued",
    "real UI labour-only Send Quote did not report durable queueing");
  assert(realUiLabourQueued.body?.decisionId && realUiLabourQueued.body?.emailLogId,
    "real UI labour-only Send Quote did not return linked queue identifiers");
  const realUiLabourOutbox = await pool.query<{
    decision_total: number;
    payload: Record<string, string>;
    status: string;
  }>(
    `select decision.estimate_total decision_total, outbox.payload, outbox.status
       from service_estimate_decisions decision
       join email_logs outbox on outbox.service_estimate_decision_id=decision.id
      where decision.id=$1 and decision.dealer_id=$2 and outbox.id=$3`,
    [realUiLabourQueued.body.decisionId, dealerId, realUiLabourQueued.body.emailLogId],
  );
  equal(realUiLabourOutbox.rows[0]?.decision_total, 114,
    "real UI labour-only queued decision lost its canonical total");
  equal(realUiLabourOutbox.rows[0]?.status, "queued",
    "real UI labour-only quote was not queued");
  assert(
    realUiLabourOutbox.rows[0]?.payload?.quoteSnapshotJson?.includes('"totalCents":11400') &&
      realUiLabourOutbox.rows[0]?.payload?.quoteSnapshotJson?.includes('"kind":"labour"'),
    "real UI labour-only queued email did not preserve its itemized snapshot",
  );
  // Historical cards can still have a persisted zero headline from before the
  // creation canonicalization. Do not rewrite that field in the fixture: the
  // sender must recover from its locked itemized labour/tax breakdown.
  const historicalZeroHeadline = await orderAndCard({
    label: "Historical zero-headline labour vehicle",
    scheduledDate: today,
    status: "open",
  });
  await pool.query(
    `update job_cards set labor_hours=1, labor_rate=100
      where id=$1 and dealer_id=$2`,
    [historicalZeroHeadline.cardId, dealerId],
  );
  const [historicalZeroCardRow] = await db.select().from(jobCardsTable).where(and(
    eq(jobCardsTable.id, historicalZeroHeadline.cardId),
    eq(jobCardsTable.dealerId, dealerId),
  ));
  assert(historicalZeroCardRow,
    "historical zero-headline quote entities are missing");
  equal(historicalZeroCardRow?.quoteTotal, 0,
    "historical zero-headline fixture unexpectedly rewrote quote total");
  const historicalZeroQueued = await api(
    `/job-cards/${historicalZeroHeadline.cardId}/estimate/resend`,
    managerEmail,
    dealerId,
    { method: "POST" },
  );
  expectStatus(historicalZeroQueued, 202,
    "Send Quote did not recover a historical zero headline from itemized work");
  equal(historicalZeroQueued.body?.outcome, "queued",
    "Send Quote did not report recovery of a historical zero headline");
  const historicalZeroDecision = await pool.query<{
    estimate_total: number;
    estimate_version: number;
  }>(
    `select estimate_total, estimate_version from service_estimate_decisions
      where id=$1 and dealer_id=$2`,
    [historicalZeroQueued.body.decisionId, dealerId],
  );
  equal(historicalZeroDecision.rows[0]?.estimate_total, 114,
    "historical zero-headline queued decision was not canonicalized");
  equal(historicalZeroDecision.rows[0]?.estimate_version, 1,
    "historical zero-headline queued decision did not open a new version");
  const queuedQuote = await orderAndCard({
    label: "Atomic queued quote vehicle",
    scheduledDate: today,
    status: "open",
    quoteTotal: 114,
  });
  await pool.query(
    `update job_cards set labor_hours=1, labor_rate=100
      where id=$1 and dealer_id=$2`,
    [queuedQuote.cardId, dealerId],
  );
  const [queuedQuoteOrder] = await db.select().from(serviceOrdersTable).where(and(
    eq(serviceOrdersTable.id, queuedQuote.orderId),
    eq(serviceOrdersTable.dealerId, dealerId),
  ));
  const [queuedQuoteCard] = await db.select().from(jobCardsTable).where(and(
    eq(jobCardsTable.id, queuedQuote.cardId),
    eq(jobCardsTable.dealerId, dealerId),
  ));
  assert(queuedQuoteOrder && queuedQuoteCard, "atomic queued-quote fixture is missing");
  const queuedQuoteOutcome = await queueServiceEstimateQuote(
    queuedQuoteOrder!,
    queuedQuoteCard!,
    { resendKey: `${marker}-atomic-queue` },
  );
  equal(queuedQuoteOutcome.outcome, "queued", "atomic quote sender did not report durable queueing");
  equal(queuedQuoteOutcome.deliveryStatus, "queued", "atomic quote sender did not report queued delivery");
  assert(queuedQuoteOutcome.decisionId && queuedQuoteOutcome.emailLogId,
    "atomic quote sender did not return linked decision and outbox identifiers");
  const queuedQuoteState = await pool.query<{
    estimate_version: number;
    estimate_approved_version: number | null;
    decision_id: number;
    decision_total: number;
    decision_version: number;
    decision_invalidated_at: Date | null;
    recipient: string;
    status: string;
    delivery_status: string | null;
    payload: Record<string, string>;
  }>(
    `select card.estimate_version, card.estimate_approved_version,
       decision.id decision_id, decision.estimate_total decision_total,
       decision.estimate_version decision_version, decision.invalidated_at decision_invalidated_at,
       outbox.recipient, outbox.status, outbox.delivery_status, outbox.payload
       from job_cards card
       join service_estimate_decisions decision on decision.id=$3 and decision.dealer_id=card.dealer_id
       join email_logs outbox on outbox.id=$4 and outbox.dealer_id=card.dealer_id
      where card.id=$1 and card.dealer_id=$2`,
    [queuedQuote.cardId, dealerId, queuedQuoteOutcome.decisionId!, queuedQuoteOutcome.emailLogId!],
  );
  const queuedState = queuedQuoteState.rows[0];
  assert(queuedState, "atomic sender did not commit card, decision, and outbox atomically");
  equal(queuedState?.estimate_version, 1, "atomic sender did not advance quote version");
  equal(queuedState?.estimate_approved_version, null, "atomic sender retained a customer approval");
  equal(queuedState?.decision_id, queuedQuoteOutcome.decisionId!, "outbox decision id mismatch");
  equal(queuedState?.decision_version, 1, "decision did not retain the new quote version");
  equal(queuedState?.decision_total, 114, "decision did not retain canonical quote total");
  equal(queuedState?.decision_invalidated_at, null, "newly queued decision was already stale");
  equal(queuedState?.recipient, `${marker}-customer@example.invalid`, "queued quote recipient");
  equal(queuedState?.status, "queued", "atomic sender did not persist queued outbox state");
  const queuedPayloadJson = queuedState?.payload?.quoteSnapshotJson;
  assert(typeof queuedPayloadJson === "string", "queued quote outbox lacks its frozen snapshot");
  const queuedPayload = queuedState?.payload ?? {};
  const queuedSnapshot = typeof queuedPayloadJson === "string"
    ? JSON.parse(queuedPayloadJson) as {
      estimateVersion: number;
      totalCents: number;
      lines: Array<{ description: string; amountCents: number }>;
    }
    : null;
  equal(queuedSnapshot?.estimateVersion, 1, "queued snapshot version");
  equal(queuedSnapshot?.totalCents, 11400, "queued snapshot canonical total");
  assert(
    queuedSnapshot?.lines.some((line) => line.description === "Labour" && line.amountCents === 10000) &&
      queuedSnapshot.lines.some((line) => line.description === "Tax" && line.amountCents === 1400),
    "queued snapshot omitted canonical itemized labour/tax terms",
  );
  assert(
    typeof queuedPayload.link === "string" &&
      queuedPayload.link.includes("/service-estimate/") &&
      typeof queuedPayload.authorizeLink === "string" &&
      queuedPayload.authorizeLink.endsWith("?decision=approved"),
    "queued quote did not retain frozen customer decision links",
  );
  const queuedQuoteRendered = renderEmail(
    "service.estimate.ready",
    queuedPayload,
    { name: `${marker} Dealer` },
  );
  for (const visibleTerm of ["Labour", "Tax", "GY$100.00", "GY$14.00", "GY$114.00"]) {
    assert(queuedQuoteRendered.html.includes(visibleTerm),
      `queued quote HTML omitted frozen commercial term ${visibleTerm}`);
  }
  assert(
    typeof queuedPayload.authorizeLink === "string" &&
      queuedQuoteRendered.html.includes(queuedPayload.authorizeLink),
    "queued quote HTML omitted its frozen authorization link",
  );
  // Simulate the exact durable state after another worker won its outbox CAS,
  // but before it can complete its final current-quote check/SMTP hand-off.
  // The charge revision must terminally cancel this claimed delivery under the
  // same card fence; a worker resuming afterwards can therefore only observe
  // a stale/cancelled item and must never mark it sent.
  await pool.query(
    `update email_logs
        set status='sending', attempts=1, delivery_status=null, sent_at=null, delivered_at=null
      where id=$1 and dealer_id=$2 and status='queued'`,
    [queuedQuoteOutcome.emailLogId!, dealerId],
  );
  const queuedQuoteRevisionPart = await pool.query<{ id: number }>(
    `insert into parts (dealer_id, sku, name, stock, reorder_level, unit_price, unit_cost, status)
     values ($1, $2, $3, 1, 0, 100, 50, 'active') returning id`,
    [
      dealerId,
      `${marker}-QUEUE-REVISION`,
      `${marker} queued quote revision part`,
    ],
  );
  const queuedQuoteRevision = await api(`/job-cards/${queuedQuote.cardId}/parts`, managerEmail, dealerId, {
    method: "POST",
    body: JSON.stringify({ partId: queuedQuoteRevisionPart.rows[0]!.id, quantity: 1 }),
  });
  expectStatus(queuedQuoteRevision, 201, "queued quote charge revision");
  const cancelledQueuedQuote = await pool.query<{
    estimate_version: number;
    decision_invalidated_at: Date | null;
    status: string;
    delivery_status: string | null;
    sent_at: Date | null;
    delivered_at: Date | null;
    payload: Record<string, string>;
  }>(
    `select card.estimate_version, decision.invalidated_at decision_invalidated_at,
       outbox.status, outbox.delivery_status, outbox.sent_at, outbox.delivered_at, outbox.payload
       from job_cards card
       join service_estimate_decisions decision on decision.id=$3 and decision.dealer_id=card.dealer_id
       join email_logs outbox on outbox.id=$4 and outbox.dealer_id=card.dealer_id
      where card.id=$1 and card.dealer_id=$2`,
    [queuedQuote.cardId, dealerId, queuedQuoteOutcome.decisionId!, queuedQuoteOutcome.emailLogId!],
  );
  equal(cancelledQueuedQuote.rows[0]?.estimate_version, 2,
    "charge revision did not advance the queued quote version");
  assert(cancelledQueuedQuote.rows[0]?.decision_invalidated_at,
    "charge revision did not invalidate the queued quote decision");
  equal(cancelledQueuedQuote.rows[0]?.status, "cancelled",
    "charge revision left a queued quote deliverable");
  equal(cancelledQueuedQuote.rows[0]?.delivery_status, "cancelled",
    "charge revision did not mark the queued quote delivery cancelled");
  equal(cancelledQueuedQuote.rows[0]?.sent_at, null,
    "stale claimed quote email reached SMTP hand-off after card revision");
  equal(cancelledQueuedQuote.rows[0]?.delivered_at, null,
    "stale claimed quote email recorded delivery after card revision");
  equal(cancelledQueuedQuote.rows[0]?.payload?.quoteSnapshotJson, queuedPayloadJson,
    "charge revision rewrote the queued quote's frozen snapshot");

  const carry = await orderAndCard({
    label: "Carryover vehicle",
    scheduledDate: twoDaysAgo,
    createdDaysAgo: 2,
    status: "on_hold",
    waitingReason: "ordered_parts",
    intake: { odometer: 12345, notes: "diagnostics preserved" },
  });
  const current = await orderAndCard({
    label: "Current vehicle",
    scheduledDate: today,
    status: "in_progress",
  });
  const future = await orderAndCard({
    label: "Future booking",
    scheduledDate: tomorrow,
    status: "open",
  });
  const receivedToday = await orderAndCard({
    label: "Received today vehicle",
    scheduledDate: twoDaysAgo,
    createdDaysAgo: 2,
    receivedDaysAgo: 0,
    status: "open",
  });
  const unassigned = await orderAndCard({
    label: "Unassigned WIP vehicle",
    scheduledDate: today,
    technician: false,
    status: "open",
  });

  const wip = await api("/job-cards/wip", managerEmail, dealerId);
  expectStatus(wip, 200, "WIP list");
  const wipRows = responseRows(wip, "WIP list");
  const carryRow = wipRows.find((row) => row.id === carry.cardId);
  assert(carryRow, "carry-over card missing from WIP");
  assert(!wipRows.some((row) => row.id === future.cardId), "future booking was misclassified as WIP");
  assert(wipRows.some((row) => row.id === current.cardId), "today's open job missing from WIP");
  const receivedTodayRow = wipRows.find((row) => row.id === receivedToday.cardId);
  assert(receivedTodayRow, "today-received card missing from WIP");
  equal(receivedTodayRow.carryOver, false, "WIP used job-card creation rather than actual receipt time");
  equal(rowNumber(receivedTodayRow, "elapsedDays"), 0, "WIP age used job-card creation rather than receipt time");
  equal(carryRow.customerName, `${marker} Customer`, "WIP customer identity");
  equal(carryRow.vehicleInfo, `${marker} Carryover vehicle`, "WIP vehicle identity");
  equal(carryRow.waitingReason, "ordered_parts", "WIP waiting reason");
  equal(carryRow.nextAction, "Awaiting regression follow-up", "WIP next action");
  equal(responseDay(carryRow.followUpDate), tomorrow, "WIP follow-up day");
  assert(rowNumber(carryRow, "elapsedDays") >= 1, "WIP elapsed dealer days");
  assert(typeof carryRow.receivedAt === "string", "WIP must expose actual received timestamp");
  assert(
    typeof carryRow.responsiblePerson === "string" || typeof carryRow.technicianName === "string",
    "WIP must expose responsible technician",
  );

  for (const query of [
    `?technicianUserId=${technicianUserId}`,
    "?minAgeDays=1",
    "?waitingReason=ordered_parts",
    "?carryOver=1",
  ]) {
    const filtered = await api(`/job-cards/wip${query}`, managerEmail, dealerId);
    expectStatus(filtered, 200, `WIP filter ${query}`);
    assert(
      responseRows(filtered, `WIP filter ${query}`).some((row) => row.id === carry.cardId),
      `carry-over row missing after WIP filter ${query}`,
    );
  }
  const notWaiting = await api("/job-cards/wip?waitingReason=diagnostics", managerEmail, dealerId);
  expectStatus(notWaiting, 200, "WIP non-matching waiting filter");
  assert(!responseRows(notWaiting, "WIP non-matching filter").some((row) => row.id === carry.cardId),
    "waiting-reason filter leaked a different reason");
  const technicianWip = await api("/job-cards/wip", technicianEmail, dealerId);
  expectStatus(technicianWip, 200, "technician WIP scope");
  assert(
    responseRows(technicianWip, "technician WIP scope").every(
      (row) => row.technicianUserId === technicianUserId || row.technicianUserId == null,
    ),
    "technician WIP exposed another technician's assigned queue",
  );
  // The established queue may include unassigned work for technicians to
  // claim, but that presentation policy is intentionally not asserted here.
  void unassigned;

  // WIP exports are generated from the same server-side scoped rows, not a
  // browser rebuild. Require carry-over detail and the absence of the future
  // booking in the downloaded representation.
  const wipExport = await api("/job-cards/wip?carryOver=1&format=csv", managerEmail, dealerId);
  expectStatus(wipExport, 200, "WIP CSV export");
  assert(/text\/csv/i.test(wipExport.response.headers.get("content-type") ?? ""),
    "WIP format=csv must return CSV");
  assert(wipExport.text.includes(`${marker} Carryover vehicle`), "WIP CSV omitted carry-over row");
  assert(!wipExport.text.includes(`${marker} Current vehicle`), "WIP CSV ignored carry-over filter");
  assert(!wipExport.text.includes(`${marker} Future booking`), "WIP CSV included future booking");

  // Put a live card on wait and resume it: intake data stays intact, history
  // remains append-only, and the work timer restarts. A pending rollover must
  // block the same resume route rather than serving as a bypass.
  const waitTarget = await orderAndCard({
    label: "Wait-resume vehicle",
    scheduledDate: yesterday,
    status: "in_progress",
    timerRunning: true,
    intake: { odometer: 54321, notes: "keep diagnostic evidence" },
  });
  const held = await api(`/job-cards/${waitTarget.cardId}/waiting`, technicianEmail, dealerId, {
    method: "PATCH",
    body: JSON.stringify({
      action: "hold",
      reason: "diagnostics",
      nextAction: "Obtain scan result",
      followUpDate: tomorrow,
    }),
  });
  expectStatus(held, 200, "put card on named wait");
  equal(held.body.status, "on_hold", "waiting hold keeps job open");
  equal(held.body.waitingReason, "diagnostics", "waiting hold reason");
  equal(held.body.intake?.odometer, 54321, "waiting hold preserves intake diagnostics");
  assert(!held.body.timerStartedAt, "waiting hold folds the running timer");

  const resumed = await api(`/job-cards/${waitTarget.cardId}/waiting`, technicianEmail, dealerId, {
    method: "PATCH",
    body: JSON.stringify({ action: "resume" }),
  });
  expectStatus(resumed, 200, "resume waiting card");
  equal(resumed.body.status, "in_progress", "resume does not fabricate completion");
  equal(resumed.body.waitingReason, null, "resume clears active waiting reason");
  assert(resumed.body.timerStartedAt, "resume restarts the work timer");
  assert(Array.isArray(resumed.body.waitingHistory) && resumed.body.waitingHistory.length >= 2,
    "waiting history retains hold and resume evidence");

  await pool.query(
    `update job_cards set status='on_hold', timer_started_at=null,
       rollover_status='pending', rollover_to_date=$2
     where id=$1 and dealer_id=$3`,
    [waitTarget.cardId, tomorrow, dealerId],
  );
  const rolloverBypass = await api(`/job-cards/${waitTarget.cardId}/waiting`, technicianEmail, dealerId, {
    method: "PATCH",
    body: JSON.stringify({ action: "resume" }),
  });
  expectStatus(rolloverBypass, 409, "pending rollover resume bypass");

  // Issuing an in-stock part while work remains on hold must not leave a
  // running timer behind. The hold stays explicit until its own resume gate
  // is satisfied; elapsed timer state is folded before the part mutation.
  const heldStockIssue = await orderAndCard({
    label: "Held stocked-part timer vehicle",
    scheduledDate: today,
    status: "on_hold",
    waitingReason: "diagnostics",
    quoteTotal: 0,
  });
  await pool.query(
    `update job_cards set timer_seconds=90, timer_started_at=now() - interval '2 minutes'
       where id=$1 and dealer_id=$2`,
    [heldStockIssue.cardId, dealerId],
  );
  const heldStockResponse = await api(`/job-cards/${heldStockIssue.cardId}/parts`, managerEmail, dealerId, {
    method: "POST",
    body: JSON.stringify({ partId, quantity: 1 }),
  });
  expectStatus(heldStockResponse, 201, "stocked part issue on held job");
  const heldStockTimer = await pool.query<{ status: string; timer_seconds: number; timer_started_at: Date | null }>(
    `select status, timer_seconds, timer_started_at from job_cards where id=$1 and dealer_id=$2`,
    [heldStockIssue.cardId, dealerId],
  );
  equal(heldStockTimer.rows[0]!.status, "on_hold", "stocked issue silently resumed held work");
  assert(heldStockTimer.rows[0]!.timer_started_at == null,
    "stocked issue left a running timer on held work");
  assert(heldStockTimer.rows[0]!.timer_seconds >= 90,
    "stocked issue did not preserve/fold elapsed held-work timer");

  // Issued-part credits: simultaneous requests cannot over-credit. Each
  // successful note creates exactly one operational return, returns stock
  // once, and changes the authoritative net parts/quote figures immediately.
  const credit = await orderAndCard({
    label: "Credit vehicle",
    scheduledDate: today,
    status: "in_progress",
    quoteTotal: 570,
  });
  const issued = await pool.query<{ id: number }>(
    `insert into job_card_parts
       (dealer_id, job_card_id, part_id, part_name, kind, quantity, unit_price, unit_cost, backordered)
     values ($1, $2, $3, $4, 'issue', 5, 100, 50, false) returning id`,
    [dealerId, credit.cardId, partId, `${marker} wrong part`],
  );
  // This fixture is inserted directly to isolate credit behavior, so mirror
  // the atomic stock issue that the production issue endpoint performed.
  await pool.query(
    `update parts set stock = stock - 5 where dealer_id=$1 and id=$2`,
    [dealerId, partId],
  );
  const issueLineId = issued.rows[0]!.id;
  // Keep the authorization probe separate so a broken server cannot mutate
  // the quantity used by the concurrency assertions below.
  const technicianCreditCard = await orderAndCard({
    label: "Technician credit authorization vehicle",
    scheduledDate: today,
    status: "in_progress",
    quoteTotal: 28.5,
  });
  const technicianCreditPart = await pool.query<{ id: number }>(
    `insert into parts (dealer_id, sku, name, stock, reorder_level, unit_price, unit_cost, status)
     values ($1, $2, $3, 1, 0, 25, 10, 'active') returning id`,
    [dealerId, `${marker}-TECH-CREDIT`, `${marker} technician-credit component`],
  );
  const technicianIssue = await pool.query<{ id: number }>(
    `insert into job_card_parts
       (dealer_id, job_card_id, part_id, part_name, kind, quantity, unit_price, unit_cost, backordered)
     values ($1, $2, $3, $4, 'issue', 1, 25, 10, false) returning id`,
    [dealerId, technicianCreditCard.cardId, technicianCreditPart.rows[0]!.id, `${marker} technician-credit component`],
  );
  const unauthorizedCredit = await api(`/job-cards/${technicianCreditCard.cardId}/credit-notes`, technicianEmail, dealerId, {
    method: "POST",
    body: JSON.stringify({ jobCardPartId: technicianIssue.rows[0]!.id, quantity: 1, reason: "Technician bypass" }),
  });
  equal(unauthorizedCredit.response.status, 403, "technician credit-adjustment bypass");
  const partial = await api(`/job-cards/${credit.cardId}/credit-notes`, managerEmail, dealerId, {
    method: "POST",
    body: JSON.stringify({ jobCardPartId: issueLineId, quantity: 2, reason: "Wrong fit" }),
  });
  expectStatus(partial, 201, "partial part credit");
  const competingCredits = await Promise.all(
    ["Wrong fit remainder A", "Wrong fit remainder B"].map((reason) =>
      api(`/job-cards/${credit.cardId}/credit-notes`, managerEmail, dealerId, {
        method: "POST",
        body: JSON.stringify({ jobCardPartId: issueLineId, quantity: 3, reason }),
      }),
    ),
  );
  equal(competingCredits.filter((result) => result.response.status === 201).length, 1,
    "only one concurrent remainder credit may succeed");
  assert(
    competingCredits.some((result) => result.response.status === 422 || result.response.status === 409),
    `over-credit concurrent request was not rejected: ${competingCredits.map((result) => result.response.status).join(", ")}`,
  );
  const retryCredit = await api(`/job-cards/${credit.cardId}/credit-notes`, managerEmail, dealerId, {
    method: "POST",
    body: JSON.stringify({ jobCardPartId: issueLineId, quantity: 1, reason: "Duplicate retry" }),
  });
  assert(retryCredit.response.status === 422 || retryCredit.response.status === 409,
    "repeat credit beyond issued quantity was accepted");
  const creditLedger = await pool.query<{ issued: string; credited: string; returns: string; stock: string }>(
    `select
       (select coalesce(sum(quantity), 0) from job_card_parts where dealer_id=$1 and job_card_id=$3 and kind='issue')::text issued,
       (select coalesce(sum(quantity), 0) from part_credit_notes where dealer_id=$1 and job_card_part_id=$2)::text credited,
       (select coalesce(sum(quantity), 0) from job_card_parts where dealer_id=$1 and job_card_id=$3 and kind='return')::text returns,
       (select stock from parts where dealer_id=$1 and id=$4)::text stock`,
    [dealerId, issueLineId, credit.cardId, partId],
  );
  equal(Number(creditLedger.rows[0]!.issued) - Number(creditLedger.rows[0]!.returns), 0,
    "net issued-parts quantity did not reconcile after credits");
  equal(Number(creditLedger.rows[0]!.credited), 5, "all credited quantities total issued quantity");
  equal(Number(creditLedger.rows[0]!.returns), 5, "stock return quantity is not duplicated");
  // The held-work timer regression above consumes one in-stock unit through
  // the real issue endpoint; these five credited fixture units must restore
  // exactly to that post-issue stock level.
  equal(Number(creditLedger.rows[0]!.stock), 9, "stock restored exactly once per credited unit");
  const creditedDetail = await api(`/job-cards/${credit.cardId}`, managerEmail, dealerId);
  expectStatus(creditedDetail, 200, "credited job detail");
  assert(
    Number(creditedDetail.body.jobCard?.quoteTotal ?? creditedDetail.body.quoteTotal) === 0,
    "credit must immediately reduce quoted total to the reconciled net parts amount",
  );

  // An issued document's line totals remain immutable; crediting afterwards
  // records a linked financial adjustment and exposes a visible remaining
  // balance rather than issuing a cash refund.
  const invoiced = await orderAndCard({
    label: "Post-invoice credit vehicle",
    scheduledDate: today,
    status: "completed",
    quoteTotal: 228,
  });
  const invoiceIssue = await pool.query<{ id: number }>(
    `insert into job_card_parts
       (dealer_id, job_card_id, part_id, part_name, kind, quantity, unit_price, unit_cost, backordered)
     values ($1, $2, $3, $4, 'issue', 2, 100, 50, false) returning id`,
    [dealerId, invoiced.cardId, partId, `${marker} invoice wrong part`],
  );
  await pool.query(
    `update parts set stock = stock - 2 where dealer_id=$1 and id=$2`,
    [dealerId, partId],
  );
  const serviceInvoice = await pool.query<{ id: number; total: string }>(
    `insert into service_invoices
       (dealer_id, service_order_id, job_card_id, customer_id, customer_name, vehicle_info,
        parts_total, external_parts_total, labor_total, surcharge_total, tax, discount_total, total,
        original_total, balance, status, locked_at, adjustments)
      values ($1, $2, $3, $4, $5, $6, 200, 0, 0, 0, 28, 0, 228, 228, 228, 'issued', now(), '[]'::jsonb)
     returning id, total::text`,
    [dealerId, invoiced.orderId, invoiced.cardId, customerId, `${marker} Customer`, `${marker} Post-invoice credit vehicle`],
  );
  const postIssue = await api(`/job-cards/${invoiced.cardId}/credit-notes`, managerEmail, dealerId, {
    method: "POST",
    body: JSON.stringify({
      jobCardPartId: invoiceIssue.rows[0]!.id,
      quantity: 1,
      reason: "Wrong issued component after invoice",
    }),
  });
  expectStatus(postIssue, 201, "post-invoice part credit");
  const invoiceAfter = await pool.query<{
    original_total: string;
    balance: string;
    parts_total: string;
    adjustments: unknown;
    card_status: string;
  }>(
    `select i.original_total::text, i.balance::text, i.parts_total::text, i.adjustments,
       jc.status card_status
       from service_invoices i
       join job_cards jc on jc.id=i.job_card_id and jc.dealer_id=i.dealer_id
       where i.id=$1 and i.dealer_id=$2`,
    [serviceInvoice.rows[0]!.id, dealerId],
  );
  equal(Number(invoiceAfter.rows[0]!.parts_total), 200, "issued invoice part line total was rewritten");
  equal(Number(invoiceAfter.rows[0]!.original_total), 228, "issued invoice original total was rewritten");
  equal(Number(invoiceAfter.rows[0]!.balance), 114, "tax-inclusive financial adjustment did not update outstanding balance");
  equal(invoiceAfter.rows[0]!.card_status, "completed",
    "post-invoice credit reopened or changed the completed job-card status");
  const adjustments = invoiceAfter.rows[0]!.adjustments as Array<Record<string, unknown>>;
  assert(Array.isArray(adjustments) && adjustments.some((entry) => Number(entry.amount) < 0),
    "post-invoice credit must append a negative financial adjustment");
  const invoiceList = await api("/service-invoices", managerEmail, dealerId);
  expectStatus(invoiceList, 200, "service invoice list after credit");
  const invoiceRow = responseRows(invoiceList, "service invoice list").find((row) => row.id === serviceInvoice.rows[0]!.id);
  assert(
    Number(invoiceRow?.balance ?? invoiceRow?.remainingBalance ?? invoiceRow?.balanceDue) === 114,
    "invoice must expose balance remaining after linked credit",
  );
  // Credit first, discount second: approval can only consume the remaining
  // receivable. A request for the original face value must be capped so the
  // issued ledger cannot become negative.
  const excessiveDiscountAfterCredit = await api(`/service-invoices/${serviceInvoice.rows[0]!.id}/discount`, managerEmail, dealerId, {
    method: "POST",
    body: JSON.stringify({ amount: 228, reason: "Credit-first cap regression" }),
  });
  equal(excessiveDiscountAfterCredit.response.status, 422,
    "discount exceeding post-credit receivable was accepted");
  const discountAfterCredit = await api(`/service-invoices/${serviceInvoice.rows[0]!.id}/discount`, managerEmail, dealerId, {
    method: "POST",
    body: JSON.stringify({ amount: 114, reason: "Credit-first cap regression" }),
  });
  expectStatus(discountAfterCredit, 200, "discount request within post-credit receivable");
  const discountAfterCreditDecision = await api(
    `/service-invoices/${serviceInvoice.rows[0]!.id}/discount/decision`,
    managerEmail,
    dealerId,
    { method: "POST", body: JSON.stringify({ action: "approve" }) },
  );
  expectStatus(discountAfterCreditDecision, 200, "discount approval after credit");
  const discountedAfterCredit = await pool.query<{
    total: string;
    balance: string;
    discount_total: string;
  }>(
    `select total::text, balance::text, discount_total::text
       from service_invoices where id=$1 and dealer_id=$2`,
    [serviceInvoice.rows[0]!.id, dealerId],
  );
  equal(Number(discountedAfterCredit.rows[0]!.total), 0,
    "credit-then-discount approval produced a negative/nonzero receivable");
  equal(Number(discountedAfterCredit.rows[0]!.balance), 0,
    "credit-then-discount approval did not cap balance at zero");
  equal(Number(discountedAfterCredit.rows[0]!.discount_total), 114,
    "discount approval was not capped to the post-credit receivable");
  // Enqueue is deliberately fire-and-forget after the credit transaction has
  // committed. Poll its durable queue record rather than assuming it has
  // completed within one scheduler tick on a freshly restarted API.
  let erpDedupe: { rows: Array<{ count: string }> } | undefined;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    erpDedupe = await pool.query<{ count: string }>(
      `select count(*)::text from erpnext_sync_jobs
       where dealer_id=$1 and entity_type='part_credit_note' and entity_id=$2`,
      [dealerId, postIssue.body.id],
    );
    if (Number(erpDedupe.rows[0]!.count) === 1) break;
    if (attempt < 29) await sleep(100);
  }
  equal(Number(erpDedupe?.rows[0]!.count), 1, "part credit has one ERP sync job/dedupe key");

  // Invoice issuance has the same hard lifecycle boundary under its lock:
  // even a current approved estimate cannot be invoiced while work remains
  // in progress.
  const unfinishedInvoice = await orderAndCard({
    label: "Unfinished invoice gate vehicle",
    scheduledDate: today,
    status: "in_progress",
    quoteTotal: 114,
  });
  await pool.query(
    `update job_cards set estimate_version=1, estimate_approved_version=1
       where id=$1 and dealer_id=$2`,
    [unfinishedInvoice.cardId, dealerId],
  );
  await pool.query(
    `insert into job_card_parts
       (dealer_id, job_card_id, part_id, part_name, kind, quantity, unit_price, unit_cost, backordered)
     values ($1, $2, $3, $4, 'issue', 1, 100, 50, false)`,
    [dealerId, unfinishedInvoice.cardId, partId, `${marker} unfinished invoice component`],
  );
  const unfinishedInvoiceAttempt = await api(`/job-cards/${unfinishedInvoice.cardId}/invoice`, managerEmail, dealerId, {
    method: "POST",
  });
  equal(unfinishedInvoiceAttempt.response.status, 422,
    "invoice issuance bypassed the completed-job lifecycle gate");

  // Credit and invoice issuance contend for the same completed job. Whichever
  // obtains the authoritative lock first must leave either one invoice with
  // the credit represented in its balance, or no invoice if the credit made
  // its estimate version stale — never two invoices or a silent mismatch.
  const creditInvoiceRace = await orderAndCard({
    label: "Credit invoice lock race vehicle",
    scheduledDate: today,
    status: "completed",
    quoteTotal: 114,
  });
  await pool.query(
    `update job_cards set estimate_version=1, estimate_approved_version=1
       where id=$1 and dealer_id=$2`,
    [creditInvoiceRace.cardId, dealerId],
  );
  const raceIssue = await pool.query<{ id: number }>(
    `insert into job_card_parts
       (dealer_id, job_card_id, part_id, part_name, kind, quantity, unit_price, unit_cost, backordered)
     values ($1, $2, $3, $4, 'issue', 1, 100, 50, false) returning id`,
    [dealerId, creditInvoiceRace.cardId, partId, `${marker} invoice-credit race component`],
  );
  const [raceCredit, raceInvoice] = await Promise.all([
    api(`/job-cards/${creditInvoiceRace.cardId}/credit-notes`, managerEmail, dealerId, {
      method: "POST",
      body: JSON.stringify({ jobCardPartId: raceIssue.rows[0]!.id, quantity: 1, reason: "Invoice race return" }),
    }),
    api(`/job-cards/${creditInvoiceRace.cardId}/invoice`, managerEmail, dealerId, { method: "POST" }),
  ]);
  equal(raceCredit.response.status, 201, "credit in invoice-lock race");
  assert(
    [201, 409, 422].includes(raceInvoice.response.status),
    "invoice-lock race returned an unexpected response",
  );
  const raceLedger = await pool.query<{ count: string; original_total: string | null; balance: string | null }>(
    `select
       (select count(*) from service_invoices where dealer_id=$1 and job_card_id=$2)::text count,
       (select original_total::text from service_invoices where dealer_id=$1 and job_card_id=$2) original_total,
       (select balance::text from service_invoices where dealer_id=$1 and job_card_id=$2) balance`,
    [dealerId, creditInvoiceRace.cardId],
  );
  assert(Number(raceLedger.rows[0]!.count) <= 1, "credit/invoice race created duplicate invoices");
  if (Number(raceLedger.rows[0]!.count) === 1) {
    equal(Number(raceLedger.rows[0]!.original_total), 114,
      "invoice race did not preserve the canonical tax-inclusive original total");
    equal(Number(raceLedger.rows[0]!.balance), 0,
      "invoice race did not reconcile the concurrent credit against balance");
  }

  // Discount approval and a part credit can reach the same issued ledger at
  // once. Both paths lock/recompute the receivable; the final total/balance
  // must equal the nonnegative canonical ledger, regardless of ordering.
  const discountCreditRace = await orderAndCard({
    label: "Discount credit ledger race vehicle",
    scheduledDate: today,
    status: "completed",
    quoteTotal: 114,
  });
  const discountRaceIssue = await pool.query<{ id: number }>(
    `insert into job_card_parts
       (dealer_id, job_card_id, part_id, part_name, kind, quantity, unit_price, unit_cost, backordered)
     values ($1, $2, $3, $4, 'issue', 1, 100, 50, false) returning id`,
    [dealerId, discountCreditRace.cardId, partId, `${marker} discount-credit race component`],
  );
  const discountRaceInvoice = await pool.query<{ id: number }>(
    `insert into service_invoices
       (dealer_id, service_order_id, job_card_id, customer_id, customer_name, vehicle_info,
        parts_total, external_parts_total, labor_total, surcharge_total, tax, discount_total, total,
        original_total, balance, status, locked_at, adjustments)
     values ($1, $2, $3, $4, $5, $6, 100, 0, 0, 0, 14, 0, 114, 114, 114, 'issued', now(), '[]'::jsonb)
     returning id`,
    [
      dealerId,
      discountCreditRace.orderId,
      discountCreditRace.cardId,
      customerId,
      `${marker} Customer`,
      `${marker} Discount credit ledger race vehicle`,
    ],
  );
  const discountRaceRequest = await api(`/service-invoices/${discountRaceInvoice.rows[0]!.id}/discount`, managerEmail, dealerId, {
    method: "POST",
    body: JSON.stringify({ amount: 114, reason: "Concurrent credit cap" }),
  });
  expectStatus(discountRaceRequest, 200, "concurrent discount request");
  const [discountRaceDecision, discountRaceCredit] = await Promise.all([
    api(`/service-invoices/${discountRaceInvoice.rows[0]!.id}/discount/decision`, managerEmail, dealerId, {
      method: "POST",
      body: JSON.stringify({ action: "approve" }),
    }),
    api(`/job-cards/${discountCreditRace.cardId}/credit-notes`, managerEmail, dealerId, {
      method: "POST",
      body: JSON.stringify({
        jobCardPartId: discountRaceIssue.rows[0]!.id,
        quantity: 1,
        reason: "Concurrent discount return",
      }),
    }),
  ]);
  assert(
    [200, 409, 422].includes(discountRaceDecision.response.status),
    `concurrent discount approval returned an unexpected status: ${discountRaceDecision.response.status}`,
  );
  assert(
    [201, 409, 422].includes(discountRaceCredit.response.status),
    `concurrent credit after discount request returned an unexpected status: ${discountRaceCredit.response.status}`,
  );
  assert(
    discountRaceDecision.response.status === 200 || discountRaceCredit.response.status === 201,
    "concurrent discount/credit requests both failed without a ledger outcome",
  );
  const discountCreditLedger = await pool.query<{
    original_total: string;
    total: string;
    balance: string;
    discount_total: string;
    adjustment_total: string;
  }>(
    `select original_total::text, total::text, balance::text, discount_total::text,
       coalesce((select sum((entry->>'amount')::numeric)
         from jsonb_array_elements(adjustments) entry), 0)::text adjustment_total
       from service_invoices where id=$1 and dealer_id=$2`,
    [discountRaceInvoice.rows[0]!.id, dealerId],
  );
  const concurrentLedger = discountCreditLedger.rows[0]!;
  const expectedConcurrentTotal = Math.max(
    0,
    Number(concurrentLedger.original_total) -
      Number(concurrentLedger.discount_total) +
      Number(concurrentLedger.adjustment_total),
  );
  equal(Number(concurrentLedger.total), expectedConcurrentTotal,
    "concurrent discount/credit total does not match its immutable ledger");
  equal(Number(concurrentLedger.balance), expectedConcurrentTotal,
    "concurrent discount/credit balance does not match its immutable ledger");
  assert(Number(concurrentLedger.total) >= 0 && Number(concurrentLedger.balance) >= 0,
    "concurrent discount/credit produced a negative receivable");

  // A paid invoice must never turn a returned part into an automatic cash
  // refund. The credit remains a visible customer-credit balance for the
  // controlled settlement workflow.
  const paidCredit = await orderAndCard({
    label: "Paid invoice credit vehicle",
    scheduledDate: today,
    status: "completed",
    quoteTotal: 114,
  });
  const paidIssue = await pool.query<{ id: number }>(
    `insert into job_card_parts
       (dealer_id, job_card_id, part_id, part_name, kind, quantity, unit_price, unit_cost, backordered)
     values ($1, $2, $3, $4, 'issue', 1, 100, 50, false) returning id`,
    [dealerId, paidCredit.cardId, partId, `${marker} paid credit component`],
  );
  const paidInvoice = await pool.query<{ id: number }>(
    `insert into service_invoices
       (dealer_id, service_order_id, job_card_id, customer_id, customer_name, vehicle_info,
        parts_total, external_parts_total, labor_total, surcharge_total, tax, discount_total, total,
        original_total, balance, status, paid_at, adjustments)
     values ($1, $2, $3, $4, $5, $6, 100, 0, 0, 0, 14, 0, 114, 114, 0, 'paid', now(), '[]'::jsonb)
     returning id`,
    [dealerId, paidCredit.orderId, paidCredit.cardId, customerId, `${marker} Customer`, `${marker} Paid invoice credit vehicle`],
  );
  const paidCreditResponse = await api(`/job-cards/${paidCredit.cardId}/credit-notes`, managerEmail, dealerId, {
    method: "POST",
    body: JSON.stringify({ jobCardPartId: paidIssue.rows[0]!.id, quantity: 1, reason: "Paid invoice return" }),
  });
  equal(paidCreditResponse.response.status, 201, "paid-invoice stock credit");
  const paidCreditLedger = await pool.query<{
    balance: string;
    customer_credit_balance: string;
    adjustments: unknown;
  }>(
    `select balance::text, customer_credit_balance::text, adjustments
       from service_invoices where id=$1 and dealer_id=$2`,
    [paidInvoice.rows[0]!.id, dealerId],
  );
  equal(Number(paidCreditLedger.rows[0]!.balance), 0, "paid invoice balance changed after a credit");
  equal(Number(paidCreditLedger.rows[0]!.customer_credit_balance), 114,
    "paid invoice credit was not retained for controlled settlement");
  assert(
    Array.isArray(paidCreditLedger.rows[0]!.adjustments) &&
      (paidCreditLedger.rows[0]!.adjustments as Array<Record<string, unknown>>)
        .some((entry) => Number(entry.amount) < 0),
    "paid invoice credit lacks an auditable financial adjustment",
  );

  // A collision allocation is split between insurer and customer. A returned
  // part cannot silently reallocate either balance: it must be held for the
  // collision settlement workflow.
  const collisionCredit = await orderAndCard({
    label: "Collision allocation credit vehicle",
    scheduledDate: today,
    status: "completed",
    quoteTotal: 114,
  });
  const collisionIssue = await pool.query<{ id: number }>(
    `insert into job_card_parts
       (dealer_id, job_card_id, part_id, part_name, kind, quantity, unit_price, unit_cost, backordered)
     values ($1, $2, $3, $4, 'issue', 1, 100, 50, false) returning id`,
    [dealerId, collisionCredit.cardId, partId, `${marker} collision credit component`],
  );
  const collisionInvoice = await pool.query<{ id: number }>(
    `insert into service_invoices
       (dealer_id, service_order_id, job_card_id, customer_id, customer_name, vehicle_info,
        parts_total, external_parts_total, labor_total, surcharge_total, tax, discount_total, total,
        original_total, balance, status, locked_at, adjustments)
     values ($1, $2, $3, $4, $5, $6, 100, 0, 0, 0, 14, 0, 114, 114, 114, 'issued', now(), '[]'::jsonb)
     returning id`,
    [dealerId, collisionCredit.orderId, collisionCredit.cardId, customerId, `${marker} Customer`, `${marker} Collision allocation credit vehicle`],
  );
  await pool.query(
    `insert into collision_claims
       (dealer_id, service_order_id, customer_id, customer_name, vehicle_info, loss_date,
        insurer_name, status, deductible, service_invoice_id, insurer_due, deductible_due)
     values ($1, $2, $3, $4, $5, $6, $7, 'invoiced', 25, $8, 89, 25)
     returning id`,
    [
      dealerId,
      collisionCredit.orderId,
      customerId,
      `${marker} Customer`,
      `${marker} Collision allocation credit vehicle`,
      today,
      `${marker} Insurer`,
      collisionInvoice.rows[0]!.id,
    ],
  );
  const collisionCreditResponse = await api(`/job-cards/${collisionCredit.cardId}/credit-notes`, managerEmail, dealerId, {
    method: "POST",
    body: JSON.stringify({ jobCardPartId: collisionIssue.rows[0]!.id, quantity: 1, reason: "Collision return" }),
  });
  equal(collisionCreditResponse.response.status, 201, "collision allocation part credit");
  const collisionCreditLedger = await pool.query<{
    balance: string;
    customer_credit_balance: string;
    credit_reconciliation_status: string | null;
  }>(
    `select balance::text, customer_credit_balance::text, credit_reconciliation_status
       from service_invoices where id=$1 and dealer_id=$2`,
    [collisionInvoice.rows[0]!.id, dealerId],
  );
  equal(Number(collisionCreditLedger.rows[0]!.balance), 114,
    "collision credit silently altered the allocated invoice balance");
  equal(Number(collisionCreditLedger.rows[0]!.customer_credit_balance), 0,
    "collision credit was incorrectly posted as customer credit");
  equal(collisionCreditLedger.rows[0]!.credit_reconciliation_status, "pending_collision_settlement",
    "collision credit was not held for reconciliation");

  // A clean collision receivable becomes paid only after both the insurer and
  // deductible shares settle, and its balance must be zeroed atomically.
  const collisionSettlement = await orderAndCard({
    label: "Collision settlement vehicle",
    scheduledDate: today,
    status: "completed",
    quoteTotal: 114,
  });
  const collisionSettlementInvoice = await pool.query<{ id: number }>(
    `insert into service_invoices
       (dealer_id, service_order_id, job_card_id, customer_id, customer_name, vehicle_info,
        parts_total, external_parts_total, labor_total, surcharge_total, tax, discount_total, total,
        original_total, balance, status, locked_at, adjustments)
     values ($1, $2, $3, $4, $5, $6, 100, 0, 0, 0, 14, 0, 114, 114, 114, 'issued', now(), '[]'::jsonb)
     returning id`,
    [dealerId, collisionSettlement.orderId, collisionSettlement.cardId, customerId,
      `${marker} Customer`, `${marker} Collision settlement vehicle`],
  );
  const settlementClaim = await pool.query<{ id: number }>(
    `insert into collision_claims
       (dealer_id, service_order_id, customer_id, customer_name, vehicle_info, loss_date,
        insurer_name, status, deductible, service_invoice_id, insurer_due, deductible_due)
     values ($1, $2, $3, $4, $5, $6, $7, 'invoiced', 25, $8, 89, 25)
     returning id`,
    [dealerId, collisionSettlement.orderId, customerId, `${marker} Customer`,
      `${marker} Collision settlement vehicle`, today, `${marker} Settlement Insurer`,
      collisionSettlementInvoice.rows[0]!.id],
  );
  const insurerSettlement = await api(`/collision-claims/${settlementClaim.rows[0]!.id}/settlements`, managerEmail, dealerId, {
    method: "POST",
    body: JSON.stringify({ payer: "insurer", amount: 89, method: "bank_transfer", reference: `${marker}-insurer` }),
  });
  expectStatus(insurerSettlement, 201, "collision insurer settlement");
  const deductibleSettlement = await api(`/collision-claims/${settlementClaim.rows[0]!.id}/settlements`, managerEmail, dealerId, {
    method: "POST",
    body: JSON.stringify({ payer: "customer", amount: 25, method: "cash", reference: `${marker}-deductible` }),
  });
  expectStatus(deductibleSettlement, 201, "collision deductible settlement");
  const settledCollisionInvoice = await pool.query<{ status: string; balance: string }>(
    `select status, balance::text from service_invoices where id=$1 and dealer_id=$2`,
    [collisionSettlementInvoice.rows[0]!.id, dealerId],
  );
  equal(settledCollisionInvoice.rows[0]!.status, "paid",
    "fully settled collision invoice was not marked paid");
  equal(Number(settledCollisionInvoice.rows[0]!.balance), 0,
    "fully settled collision invoice retained a balance");

  // A return discovered after a collision invoice is fully settled is still
  // insurer/deductible allocation work. It must not create a whole-credit
  // customer balance simply because the invoice status is now paid.
  const paidCollisionIssue = await pool.query<{ id: number }>(
    `insert into job_card_parts
       (dealer_id, job_card_id, part_id, part_name, kind, quantity, unit_price, unit_cost, backordered)
     values ($1, $2, $3, $4, 'issue', 1, 100, 50, false) returning id`,
     [dealerId, collisionSettlement.cardId, partId, `${marker} paid collision return component`],
  );
  const paidCollisionCredit = await api(`/job-cards/${collisionSettlement.cardId}/credit-notes`, managerEmail, dealerId, {
    method: "POST",
    body: JSON.stringify({
      jobCardPartId: paidCollisionIssue.rows[0]!.id,
      quantity: 1,
      reason: "Paid collision allocation return",
    }),
  });
  expectStatus(paidCollisionCredit, 201, "paid collision part credit");
  const paidCollisionLedger = await pool.query<{
    status: string;
    balance: string;
    customer_credit_balance: string;
    credit_reconciliation_status: string | null;
  }>(
    `select status, balance::text, customer_credit_balance::text, credit_reconciliation_status
       from service_invoices where id=$1 and dealer_id=$2`,
    [collisionSettlementInvoice.rows[0]!.id, dealerId],
  );
  equal(paidCollisionLedger.rows[0]!.status, "paid",
    "paid collision credit changed settlement status");
  equal(Number(paidCollisionLedger.rows[0]!.balance), 0,
    "paid collision credit reopened a settled balance");
  equal(Number(paidCollisionLedger.rows[0]!.customer_credit_balance), 0,
    "paid collision credit was incorrectly posted as whole-customer credit");
  equal(paidCollisionLedger.rows[0]!.credit_reconciliation_status, "pending_collision_settlement",
    "paid collision credit was not retained for split reconciliation");

  // Exact-version public customer consent. The bearer token decision must bind
  // to the card price snapshot and record safe evidence; a stale/expired link
  // must not mutate the card, and a generic legacy quote flag cannot bypass it.
  const approval = await orderAndCard({
    label: "Exact approval vehicle",
    scheduledDate: today,
    status: "open",
    quoteTotal: 342,
  });
  await pool.query(
    `update job_cards set estimate_version=1, estimate_approved_version=null,
       estimate_approval_at=null, estimate_approval_evidence=null, quote_approved_at=null,
       labor_hours=3, labor_rate=100
     where id=$1 and dealer_id=$2`,
    [approval.cardId, dealerId],
  );
  const approvalToken = token();
  const competingApprovalToken = token();
  await pool.query(
    `insert into service_estimate_decisions
       (dealer_id, service_order_id, job_card_id, token_hash, estimate_total, lines_snapshot,
        estimate_version, expires_at)
      values
       ($1, $2, $3, $4, 342, $5::jsonb, 1, now() + interval '1 hour'),
       ($1, $2, $3, $6, 342, $5::jsonb, 1, now() + interval '1 hour')`,
    [
      dealerId,
      approval.orderId,
      approval.cardId,
      tokenHash(approvalToken),
      JSON.stringify([
        { kind: "labour", description: "Labour", quantity: 3, amount: 300 },
        { kind: "tax", description: "Tax", quantity: 1, amount: 42 },
      ]),
      tokenHash(competingApprovalToken),
    ],
  );
  const competingApprovals = await Promise.all([
    api(`/service-estimates/${approvalToken}`, null, dealerId, {
      method: "POST",
      body: JSON.stringify({ decision: "approved" }),
    }),
    api(`/service-estimates/${competingApprovalToken}`, null, dealerId, {
      method: "POST",
      body: JSON.stringify({ decision: "approved" }),
    }),
  ]);
  // Duplicate historical active tokens are ambiguous: fail both closed rather
  // than letting one customer decision silently override another. A freshly
  // issued sole token is then the only decision eligible to settle.
  equal(competingApprovals.filter((result) => result.response.status === 200).length, 0,
    "duplicate active estimate tokens did not fail closed");
  assert(
    competingApprovals.every((result) => result.response.status === 409),
    "duplicate active estimate tokens returned an unexpected result",
  );
  await pool.query(
    `update service_estimate_decisions set invalidated_at=now()
       where dealer_id=$1 and job_card_id=$2 and estimate_version=1`,
    [dealerId, approval.cardId],
  );
  const soleApprovalToken = token();
  await pool.query(
    `insert into service_estimate_decisions
       (dealer_id, service_order_id, job_card_id, token_hash, estimate_total, lines_snapshot,
        estimate_version, expires_at)
     values ($1, $2, $3, $4, 342, $5::jsonb, 1, now() + interval '1 hour')`,
    [
      dealerId,
      approval.orderId,
      approval.cardId,
      tokenHash(soleApprovalToken),
      JSON.stringify([
        { kind: "labour", description: "Labour", quantity: 3, amount: 300 },
        { kind: "tax", description: "Tax", quantity: 1, amount: 42 },
      ]),
    ],
  );
  const publicApproval = await api(`/service-estimates/${soleApprovalToken}`, null, dealerId, {
    method: "POST",
    body: JSON.stringify({ decision: "approved" }),
  });
  expectStatus(publicApproval, 200, "sole exact-version public approval");
  equal(publicApproval.body.state, "approved", "public estimate decision state");
  equal(publicApproval.body.estimateVersion, 1, "public estimate exposes approved version");
  const approvedPreview = await api(`/job-cards/${approval.cardId}/estimate/preview`, managerEmail, dealerId);
  expectStatus(approvedPreview, 200, "approved itemized estimate preview");
  equal(approvedPreview.body.estimateVersion, 1, "preview estimate version");
  equal(Number(approvedPreview.body.total), 342, "preview canonical tax-inclusive total");
  equal(approvedPreview.body.customerRecipient, `${marker}-customer@example.invalid`,
    "preview customer recipient");
  equal(approvedPreview.body.decision?.state, "approved", "preview approved decision state");
  equal(approvedPreview.body.delivery?.recipient, `${marker}-customer@example.invalid`,
    "preview delivery recipient");
  assert(
    JSON.stringify(approvedPreview.body.lines) === JSON.stringify([
      { kind: "labour", description: "Labour", quantity: 3, amount: 300 },
      { kind: "tax", description: "Tax", quantity: 1, amount: 42 },
    ]),
    "preview itemized lines do not match the exact canonical estimate",
  );
  assert(!JSON.stringify(approvedPreview.body).includes(approvalToken),
    "staff preview exposed an estimate bearer token");
  // Render only a frozen outbox-equivalent snapshot: this validates the exact
  // customer-visible commercial terms without configuring SMTP or contacting
  // a real recipient.
  const frozenQuoteSnapshot = JSON.stringify({
    customerName: `${marker} Customer`,
    vehicle: `${marker} Exact approval vehicle`,
    reference: `Job card #${approval.cardId}`,
    estimateVersion: 1,
    expiresAt: "2099-01-01",
    totalCents: 34200,
    lines: [
      {
        kind: "labour",
        description: "Labour",
        quantity: 3,
        unitRateCents: 10000,
        amountCents: 30000,
      },
      {
        kind: "tax",
        description: "Tax",
        quantity: 1,
        unitRateCents: null,
        amountCents: 4200,
      },
    ],
  });
  const renderedQuote = renderEmail("service.estimate.ready", {
    quoteSnapshotJson: frozenQuoteSnapshot,
    link: "https://example.invalid/service-estimate/review",
    authorizeLink: "https://example.invalid/service-estimate/authorize",
    declineLink: "https://example.invalid/service-estimate/decline",
  }, { name: `${marker} Dealer` });
  for (const visibleTerm of ["Labour", "Tax", "GY$300.00", "GY$42.00", "GY$342.00", "AUTHORIZE QUOTE"]) {
    assert(renderedQuote.html.includes(visibleTerm),
      `itemized quote email omitted frozen commercial term ${visibleTerm}`);
  }
  const customerOnlyResume = await api(`/job-cards/${approval.cardId}`, managerEmail, dealerId, {
    method: "PATCH",
    body: JSON.stringify({ status: "in_progress" }),
  });
  equal(customerOnlyResume.response.status, 422,
    "customer approval alone resumed chargeable work without staff acknowledgement");
  const foreignAck = await api(`/job-cards/${approval.cardId}/estimate/acknowledge`, managerEmail, otherDealerId, {
    method: "POST",
  });
  assert([403, 404].includes(foreignAck.response.status),
    "cross-dealer staff acknowledgement was not rejected");
  const unauthenticatedAck = await api(`/job-cards/${approval.cardId}/estimate/acknowledge`, null, dealerId, {
    method: "POST",
  });
  assert([401, 403].includes(unauthenticatedAck.response.status),
    "unauthenticated staff acknowledgement was not rejected");
  const firstAcknowledgement = await api(`/job-cards/${approval.cardId}/estimate/acknowledge`, managerEmail, dealerId, {
    method: "POST",
  });
  expectStatus(firstAcknowledgement, 200, "staff acknowledgement after customer approval");
  const repeatedAcknowledgement = await api(`/job-cards/${approval.cardId}/estimate/acknowledge`, managerEmail, dealerId, {
    method: "POST",
  });
  expectStatus(repeatedAcknowledgement, 200, "idempotent same-version staff acknowledgement");
  equal(
    repeatedAcknowledgement.body.estimateStaffAcknowledgedDecisionId,
    firstAcknowledgement.body.estimateStaffAcknowledgedDecisionId,
    "same-version acknowledgement changed its decision evidence",
  );
  equal(repeatedAcknowledgement.body.estimateStaffAcknowledgedByUserId, managerUserId,
    "staff acknowledgement did not record authenticated actor");
  const approvedCard = await pool.query<{
    estimate_version: number;
    estimate_approved_version: number | null;
    estimate_approval_at: Date | null;
    estimate_approval_evidence: unknown;
    estimate_staff_acknowledged_version: number | null;
    estimate_staff_acknowledged_decision_id: number | null;
    estimate_staff_acknowledged_by_user_id: number | null;
    estimate_staff_acknowledged_at: Date | null;
  }>(
    `select estimate_version, estimate_approved_version, estimate_approval_at, estimate_approval_evidence,
       estimate_staff_acknowledged_version, estimate_staff_acknowledged_decision_id,
       estimate_staff_acknowledged_by_user_id, estimate_staff_acknowledged_at
       from job_cards where id=$1 and dealer_id=$2`,
    [approval.cardId, dealerId],
  );
  equal(approvedCard.rows[0]!.estimate_approved_version, 1, "approval records exact version");
  assert(approvedCard.rows[0]!.estimate_approval_at, "approval records timestamp");
  assert(approvedCard.rows[0]!.estimate_approval_evidence, "approval stores acknowledgement evidence");
  equal(approvedCard.rows[0]!.estimate_staff_acknowledged_version, 1,
    "staff acknowledgement records the exact approved version");
  assert(approvedCard.rows[0]!.estimate_staff_acknowledged_decision_id,
    "staff acknowledgement lacks its approved decision reference");
  equal(approvedCard.rows[0]!.estimate_staff_acknowledged_by_user_id, managerUserId,
    "staff acknowledgement lacks authenticated actor evidence");
  assert(approvedCard.rows[0]!.estimate_staff_acknowledged_at,
    "staff acknowledgement lacks receipt timestamp");
  const replay = await api(`/service-estimates/${approvalToken}`, null, dealerId, {
    method: "POST",
    body: JSON.stringify({ decision: "approved" }),
  });
  expectStatus(replay, 409, "estimate approval replay");

  const stale = await orderAndCard({
    label: "Stale estimate vehicle",
    scheduledDate: today,
    status: "open",
    quoteTotal: 0,
  });
  const staleToken = token();
  await pool.query(
    `update job_cards set estimate_version=2 where id=$1 and dealer_id=$2`,
    [stale.cardId, dealerId],
  );
  await pool.query(
    `insert into service_estimate_decisions
       (dealer_id, service_order_id, job_card_id, token_hash, estimate_total, lines_snapshot,
        estimate_version, expires_at)
      values ($1, $2, $3, $4, 0, '[]'::jsonb, 1, now() + interval '1 hour')`,
    [dealerId, stale.orderId, stale.cardId, tokenHash(staleToken)],
  );
  const staleApproval = await api(`/service-estimates/${staleToken}`, null, dealerId, {
    method: "POST",
    body: JSON.stringify({ decision: "approved" }),
  });
  expectStatus(staleApproval, 409, "stale estimate approval");

  const expired = await orderAndCard({
    label: "Expired estimate vehicle",
    scheduledDate: today,
    status: "open",
    quoteTotal: 0,
  });
  const expiredToken = token();
  await pool.query(
    `insert into service_estimate_decisions
       (dealer_id, service_order_id, job_card_id, token_hash, estimate_total, lines_snapshot,
        estimate_version, expires_at)
      values ($1, $2, $3, $4, 0, '[]'::jsonb, 0, now() - interval '1 minute')`,
    [dealerId, expired.orderId, expired.cardId, tokenHash(expiredToken)],
  );
  const expiredApproval = await api(`/service-estimates/${expiredToken}`, null, dealerId, {
    method: "POST",
    body: JSON.stringify({ decision: "approved" }),
  });
  expectStatus(expiredApproval, 410, "expired estimate approval");

  // Direct status, timer, and reopen endpoints must share the exact-version
  // gate; otherwise a staff member could bypass customer approval without
  // touching the normal parts/estimate screen.
  const approvalGate = await orderAndCard({
    label: "Approval-gated lifecycle vehicle",
    scheduledDate: today,
    status: "in_progress",
    quoteTotal: 114,
  });
  await pool.query(
    `update job_cards set estimate_version=1, estimate_approved_version=0, timer_started_at=now(),
       labor_hours=1, labor_rate=100
       where id=$1 and dealer_id=$2`,
    [approvalGate.cardId, dealerId],
  );
  const completionBypass = await api(`/job-cards/${approvalGate.cardId}`, managerEmail, dealerId, {
    method: "PATCH",
    body: JSON.stringify({ status: "completed" }),
  });
  equal(completionBypass.response.status, 422, "completion bypassed current customer estimate approval");
  const timerPause = await api(`/job-cards/${approvalGate.cardId}/timer`, technicianEmail, dealerId, {
    method: "POST",
    body: JSON.stringify({ action: "pause" }),
  });
  equal(timerPause.response.status, 200, "timer pause before approval-gate check");
  const timerResume = await api(`/job-cards/${approvalGate.cardId}/timer`, technicianEmail, dealerId, {
    method: "POST",
    body: JSON.stringify({ action: "resume" }),
  });
  equal(timerResume.response.status, 422, "timer resume bypassed current customer estimate approval");
  await pool.query(
    `update job_cards set status='completed', timer_started_at=null
       where id=$1 and dealer_id=$2`,
    [approvalGate.cardId, dealerId],
  );
  const reopenBypass = await api(`/job-cards/${approvalGate.cardId}/reopen`, managerEmail, dealerId, {
    method: "POST",
    body: JSON.stringify({ reason: "Approval-gate regression" }),
  });
  equal(reopenBypass.response.status, 422, "reopen bypassed current customer estimate approval");

  // Changing a positive in-progress warranty/goodwill case to customer pay
  // creates a new customer liability. It must version/reset the old approval
  // and fold the timer while holding for the newly required decision.
  const payTypeTransition = await orderAndCard({
    label: "Warranty to customer-pay approval vehicle",
    scheduledDate: today,
    status: "in_progress",
    quoteTotal: 114,
  });
  await pool.query(
    `update job_cards
       set pay_type='warranty', estimate_version=4, estimate_approved_version=4,
           estimate_approval_at=now(), timer_seconds=90, timer_started_at=now() - interval '2 minutes'
       where id=$1 and dealer_id=$2`,
    [payTypeTransition.cardId, dealerId],
  );
  const customerPayTransition = await api(`/job-cards/${payTypeTransition.cardId}`, managerEmail, dealerId, {
    method: "PATCH",
    body: JSON.stringify({ payType: "customer" }),
  });
  expectStatus(customerPayTransition, 200, "warranty-to-customer pay transition");
  const transitionedCard = await pool.query<{
    pay_type: string;
    estimate_version: number;
    estimate_approved_version: number | null;
    status: string;
    waiting_reason: string | null;
    timer_seconds: number;
    timer_started_at: Date | null;
  }>(
    `select pay_type, estimate_version, estimate_approved_version, status, waiting_reason,
       timer_seconds, timer_started_at
       from job_cards where id=$1 and dealer_id=$2`,
    [payTypeTransition.cardId, dealerId],
  );
  equal(transitionedCard.rows[0]!.pay_type, "customer", "pay type transition was not saved");
  equal(transitionedCard.rows[0]!.estimate_version, 5,
    "customer pay transition did not create a new estimate version");
  equal(transitionedCard.rows[0]!.estimate_approved_version, null,
    "customer pay transition retained the noncustomer approval");
  equal(transitionedCard.rows[0]!.status, "on_hold",
    "customer pay transition did not hold chargeable in-progress work");
  equal(transitionedCard.rows[0]!.waiting_reason, "customer_decision",
    "customer pay transition did not identify the approval hold");
  assert(transitionedCard.rows[0]!.timer_started_at == null,
    "customer pay transition left a running timer while on approval hold");
  assert(transitionedCard.rows[0]!.timer_seconds >= 90,
    "customer pay transition did not fold the running timer");

  const declined = await orderAndCard({
    label: "Declined estimate vehicle",
    scheduledDate: today,
    status: "in_progress",
    quoteTotal: 114,
  });
  await pool.query(
    `update job_cards set labor_hours=1, labor_rate=100 where id=$1 and dealer_id=$2`,
    [declined.cardId, dealerId],
  );
  const declineToken = token();
  await pool.query(
    `insert into service_estimate_decisions
       (dealer_id, service_order_id, job_card_id, token_hash, estimate_total, lines_snapshot,
        estimate_version, expires_at)
      values ($1, $2, $3, $4, 114, $5::jsonb, 0, now() + interval '1 hour')`,
    [
      dealerId,
      declined.orderId,
      declined.cardId,
      tokenHash(declineToken),
      JSON.stringify([
        { kind: "labour", description: "Labour", quantity: 1, amount: 100 },
        { kind: "tax", description: "Tax", quantity: 1, amount: 14 },
      ]),
    ],
  );
  const decline = await api(`/service-estimates/${declineToken}`, null, dealerId, {
    method: "POST",
    body: JSON.stringify({ decision: "declined" }),
  });
  expectStatus(decline, 200, "customer estimate decline");
  const declinedCharge = await api(`/job-cards/${declined.cardId}/parts`, managerEmail, dealerId, {
    method: "POST",
    body: JSON.stringify({ partId, quantity: 1 }),
  });
  if (declinedCharge.response.status === 201) {
    const declinedRevision = await pool.query<{
      estimate_version: number;
      estimate_approved_version: number | null;
      status: string;
    }>(
      `select estimate_version, estimate_approved_version, status
         from job_cards where id=$1 and dealer_id=$2`,
      [declined.cardId, dealerId],
    );
    assert(declinedRevision.rows[0]!.estimate_version > 0,
      "charge after decline did not create a revised estimate");
    assert(
      declinedRevision.rows[0]!.estimate_approved_version !== declinedRevision.rows[0]!.estimate_version,
      "charge after decline retained an obsolete estimate approval",
    );
    equal(declinedRevision.rows[0]!.status, "on_hold",
      "charge after decline did not wait for revised customer approval");
  } else {
    assert(declinedCharge.response.status === 409 || declinedCharge.response.status === 422,
      "declined estimate charge was rejected with an unexpected response");
  }

  await pool.query(
    `update job_cards set quote_approved_at=now(), estimate_version=2,
       estimate_approved_version=1 where id=$1 and dealer_id=$2`,
    [approval.cardId, dealerId],
  );
  const staleQueuedEstimateEmail = await pool.query<{ id: number }>(
    `insert into email_logs
       (dealer_id, customer_id, service_estimate_decision_id, recipient, subject, template,
        channel, status, delivery_status, payload, dedupe_key)
     values ($1, $2, $3, $4, $5, 'service.estimate.ready',
       'email', 'queued', 'queued', '{}'::jsonb, $6)
     returning id`,
    [
      dealerId,
      customerId,
      firstAcknowledgement.body.estimateStaffAcknowledgedDecisionId,
      `${marker}-customer@example.invalid`,
      `${marker} stale queued quote`,
      `${marker}:stale-estimate-email`,
    ],
  );
  const genericFlagBypass = await api(`/job-cards/${approval.cardId}/parts`, managerEmail, dealerId, {
    method: "POST",
    body: JSON.stringify({ partId, quantity: 1 }),
  });
  if (genericFlagBypass.response.status === 201) {
    const revised = await pool.query<{
      estimate_version: number;
      estimate_approved_version: number | null;
      estimate_staff_acknowledged_version: number | null;
      estimate_staff_acknowledged_decision_id: number | null;
    }>(
      `select estimate_version, estimate_approved_version, estimate_staff_acknowledged_version,
       estimate_staff_acknowledged_decision_id from job_cards where id=$1 and dealer_id=$2`,
      [approval.cardId, dealerId],
    );
    assert(revised.rows[0]!.estimate_version > 2, "charge change did not make a revised estimate version");
    assert(
      revised.rows[0]!.estimate_approved_version !== revised.rows[0]!.estimate_version,
      "charge change retained a stale exact-version approval",
    );
    assert(
      revised.rows[0]!.estimate_staff_acknowledged_version !== revised.rows[0]!.estimate_version &&
        revised.rows[0]!.estimate_staff_acknowledged_decision_id == null,
      "charge change retained staff acknowledgement for a revised estimate",
    );
    const cancelledStaleEstimateEmail = await pool.query<{
      status: string;
      delivery_status: string | null;
    }>(
      `select status, delivery_status from email_logs where id=$1 and dealer_id=$2`,
      [staleQueuedEstimateEmail.rows[0]!.id, dealerId],
    );
    equal(cancelledStaleEstimateEmail.rows[0]!.status, "cancelled",
      "quote revision left a stale queued estimate email deliverable");
    equal(cancelledStaleEstimateEmail.rows[0]!.delivery_status, "cancelled",
      "quote revision did not mark stale estimate delivery cancelled");
  } else {
    assert(genericFlagBypass.response.status === 409 || genericFlagBypass.response.status === 422,
      "legacy generic quote-approved flag bypassed exact-version approval");
  }
  const staleInvoiceAttempt = await api(`/job-cards/${approval.cardId}/invoice`, managerEmail, dealerId, {
    method: "POST",
  });
  expectStatus(staleInvoiceAttempt, 422, "invoice generation with stale estimate approval");

  // An EXTERNAL-only requisition fulfils a positively priced, already
  // customer-approved quote. It is just as commercially material as an
  // internal-stock issue: receiving it must create a revised quote, invalidate
  // both attestations and stop its prior quote delivery before a replacement
  // quote can be queued.
  const externalAuthorization = await orderAndCard({
    label: "External-only authorized quote vehicle",
    scheduledDate: today,
    status: "in_progress",
    quoteTotal: 114,
  });
  await pool.query(
    `update job_cards set labor_hours=1, labor_rate=100
      where id=$1 and dealer_id=$2`,
    [externalAuthorization.cardId, dealerId],
  );
  const [externalAuthorizationOrder] = await db.select().from(serviceOrdersTable).where(and(
    eq(serviceOrdersTable.id, externalAuthorization.orderId),
    eq(serviceOrdersTable.dealerId, dealerId),
  ));
  const [externalAuthorizationCard] = await db.select().from(jobCardsTable).where(and(
    eq(jobCardsTable.id, externalAuthorization.cardId),
    eq(jobCardsTable.dealerId, dealerId),
  ));
  assert(
    externalAuthorizationOrder && externalAuthorizationCard,
    "external-only authorization fixture is missing",
  );
  const externalInitialQuote = await queueServiceEstimateQuote(
    externalAuthorizationOrder!,
    externalAuthorizationCard!,
    { resendKey: `${marker}-external-initial` },
  );
  equal(externalInitialQuote.outcome, "queued", "external-only initial quote did not queue");
  const externalInitialOutbox = await pool.query<{
    payload: Record<string, string>;
    status: string;
    delivery_status: string | null;
  }>(
    `select payload, status, delivery_status from email_logs
      where id=$1 and dealer_id=$2`,
    [externalInitialQuote.emailLogId!, dealerId],
  );
  equal(externalInitialOutbox.rows[0]?.status, "queued", "external-only initial quote outbox state");
  const externalInitialLink = externalInitialOutbox.rows[0]?.payload?.link;
  const externalInitialToken = typeof externalInitialLink === "string"
    ? new URL(externalInitialLink).pathname.split("/").filter(Boolean).at(-1) ?? ""
    : "";
  assert(externalInitialToken, "external-only initial quote lacks a customer token");
  const externalCustomerApproval = await api(
    `/service-estimates/${externalInitialToken}`,
    null,
    dealerId,
    { method: "POST", body: JSON.stringify({ decision: "approved" }) },
  );
  expectStatus(externalCustomerApproval, 200, "external-only initial customer approval");
  const externalStaffAcknowledgement = await api(
    `/job-cards/${externalAuthorization.cardId}/estimate/acknowledge`,
    managerEmail,
    dealerId,
    { method: "POST" },
  );
  expectStatus(externalStaffAcknowledgement, 200, "external-only initial staff acknowledgement");
  const externalAuthorizedSupplier = await pool.query<{ id: number }>(
    `insert into suppliers (dealer_id, name, status) values ($1, $2, 'active') returning id`,
    [dealerId, `${marker} External-only authorization supplier`],
  );
  const externalAuthorizedRequisition = await pool.query<{ id: number }>(
    `insert into part_requisitions
       (dealer_id, service_order_id, job_card_id, requester_user_id, requester_name, status, urgency)
     values ($1, $2, $3, $4, $5, 'ordered', 'routine') returning id`,
    [
      dealerId,
      externalAuthorization.orderId,
      externalAuthorization.cardId,
      managerUserId,
      `${marker} Manager`,
    ],
  );
  const externalAuthorizedReqLine = await pool.query<{ id: number }>(
    `insert into part_requisition_lines
       (dealer_id, requisition_id, source, description_snapshot, supplier_snapshot, quantity, unit_cost, unit_price)
     values ($1, $2, 'EXTERNAL', $3, $4, 1, 75, 125) returning id`,
    [
      dealerId,
      externalAuthorizedRequisition.rows[0]!.id,
      `${marker} External-only authorized component`,
      `${marker} External-only authorization supplier`,
    ],
  );
  const externalAuthorizedPo = await pool.query<{ id: number }>(
    `insert into purchase_orders (dealer_id, supplier_id, status, expected_date, reference)
     values ($1, $2, 'ordered', $3, $4) returning id`,
    [
      dealerId,
      externalAuthorizedSupplier.rows[0]!.id,
      today,
      `${marker}-EXTERNAL-AUTH-PO`,
    ],
  );
  const externalAuthorizedPoLine = await pool.query<{ id: number }>(
    `insert into purchase_order_lines
       (dealer_id, purchase_order_id, source, part_name, quantity, qty_received, unit_cost, job_card_id)
     values ($1, $2, 'EXTERNAL', $3, 1, 0, 75, $4) returning id`,
    [
      dealerId,
      externalAuthorizedPo.rows[0]!.id,
      `${marker} External-only authorized component`,
      externalAuthorization.cardId,
    ],
  );
  await pool.query(
    `insert into part_requisition_po_allocations
       (dealer_id, requisition_id, requisition_line_id, supplier_id, purchase_order_id, purchase_order_line_id,
        idempotency_key, quantity_ordered, quantity_received)
     values ($1, $2, $3, $4, $5, $6, $7, 1, 0)`,
    [
      dealerId,
      externalAuthorizedRequisition.rows[0]!.id,
      externalAuthorizedReqLine.rows[0]!.id,
      externalAuthorizedSupplier.rows[0]!.id,
      externalAuthorizedPo.rows[0]!.id,
      externalAuthorizedPoLine.rows[0]!.id,
      `${marker}-external-auth-allocation`,
    ],
  );
  const externalAuthorizedReceipt = await api(
    `/purchase-orders/${externalAuthorizedPo.rows[0]!.id}/receive`,
    managerEmail,
    dealerId,
    {
      method: "POST",
      body: JSON.stringify({
        idempotencyKey: `${marker}-external-auth-receipt`,
        receivedAt: new Date().toISOString(),
        deliveryNoteNumber: `${marker}-DN-EXT-AUTH`,
        warehouseLocation: "External supplier",
        condition: "accepted",
        documents: [{
          objectPath: `/objects/uploads/dealer-${dealerId}/${marker}-external-auth-receipt.pdf`,
          fileName: "external-auth-receipt.pdf",
          mimeType: "application/pdf",
        }],
        lines: [{ lineId: externalAuthorizedPoLine.rows[0]!.id, qty: 1 }],
      }),
    },
  );
  expectStatus(externalAuthorizedReceipt, 200, "external-only authorized PO receipt");
  const externalAuthorizedEffects = await pool.query<{
    estimate_version: number;
    quote_total: number;
    estimate_approved_version: number | null;
    estimate_staff_acknowledged_version: number | null;
    estimate_staff_acknowledged_decision_id: number | null;
    status: string;
    waiting_reason: string | null;
    decision_invalidated_at: Date | null;
    outbox_status: string;
    outbox_delivery_status: string | null;
  }>(
    `select card.estimate_version, card.quote_total, card.estimate_approved_version,
       card.estimate_staff_acknowledged_version, card.estimate_staff_acknowledged_decision_id,
       card.status, card.waiting_reason, decision.invalidated_at decision_invalidated_at,
       outbox.status outbox_status, outbox.delivery_status outbox_delivery_status
       from job_cards card
       join service_estimate_decisions decision on decision.id=$3 and decision.dealer_id=card.dealer_id
       join email_logs outbox on outbox.id=$4 and outbox.dealer_id=card.dealer_id
      where card.id=$1 and card.dealer_id=$2`,
    [
      externalAuthorization.cardId,
      dealerId,
      externalInitialQuote.decisionId!,
      externalInitialQuote.emailLogId!,
    ],
  );
  const externalAuthorizedEffect = externalAuthorizedEffects.rows[0];
  equal(externalAuthorizedEffect?.estimate_version, 2,
    "external-only fulfillment did not make a revised estimate version");
  equal(externalAuthorizedEffect?.quote_total, 256.5,
    "external-only fulfillment did not persist the canonical tax-inclusive total");
  equal(externalAuthorizedEffect?.estimate_approved_version, null,
    "external-only fulfillment retained customer approval for an old quote");
  equal(externalAuthorizedEffect?.estimate_staff_acknowledged_version, null,
    "external-only fulfillment retained staff acknowledgement for an old quote");
  equal(externalAuthorizedEffect?.estimate_staff_acknowledged_decision_id, null,
    "external-only fulfillment retained staff decision evidence for an old quote");
  equal(externalAuthorizedEffect?.status, "on_hold",
    "external-only fulfillment did not hold chargeable work for the revised quote");
  equal(externalAuthorizedEffect?.waiting_reason, "customer_decision",
    "external-only fulfillment did not identify the revised-quote decision hold");
  assert(externalAuthorizedEffect?.decision_invalidated_at,
    "external-only fulfillment did not stale the old customer token");
  equal(externalAuthorizedEffect?.outbox_status, "cancelled",
    "external-only fulfillment left the old queued quote deliverable");
  equal(externalAuthorizedEffect?.outbox_delivery_status, "cancelled",
    "external-only fulfillment did not cancel old quote delivery");
  const staleExternalToken = await api(
    `/service-estimates/${externalInitialToken}`,
    null,
    dealerId,
    { method: "POST", body: JSON.stringify({ decision: "approved" }) },
  );
  expectStatus(staleExternalToken, 409, "external-only fulfillment stale customer token");
  const [externalReplacementOrder] = await db.select().from(serviceOrdersTable).where(and(
    eq(serviceOrdersTable.id, externalAuthorization.orderId),
    eq(serviceOrdersTable.dealerId, dealerId),
  ));
  const [externalReplacementCard] = await db.select().from(jobCardsTable).where(and(
    eq(jobCardsTable.id, externalAuthorization.cardId),
    eq(jobCardsTable.dealerId, dealerId),
  ));
  assert(
    externalReplacementOrder && externalReplacementCard,
    "external-only replacement quote fixture is missing",
  );
  const externalReplacementQuote = await queueServiceEstimateQuote(
    externalReplacementOrder!,
    externalReplacementCard!,
    { resendKey: `${marker}-external-replacement` },
  );
  equal(externalReplacementQuote.outcome, "queued",
    "external-only revised quote could not be queued");
  const externalReplacementOutbox = await pool.query<{
    estimate_version: number;
    decision_version: number;
    status: string;
    recipient: string;
  }>(
    `select card.estimate_version, decision.estimate_version decision_version,
       outbox.status, outbox.recipient
       from job_cards card
       join service_estimate_decisions decision on decision.id=$3 and decision.dealer_id=card.dealer_id
       join email_logs outbox on outbox.id=$4 and outbox.dealer_id=card.dealer_id
      where card.id=$1 and card.dealer_id=$2`,
    [
      externalAuthorization.cardId,
      dealerId,
      externalReplacementQuote.decisionId!,
      externalReplacementQuote.emailLogId!,
    ],
  );
  equal(externalReplacementOutbox.rows[0]?.estimate_version, 3,
    "external-only replacement quote did not advance the quote version");
  equal(externalReplacementOutbox.rows[0]?.decision_version, 3,
    "external-only replacement decision did not bind its version");
  equal(externalReplacementOutbox.rows[0]?.status, "queued",
    "external-only replacement quote was not durably queued");
  equal(externalReplacementOutbox.rows[0]?.recipient, `${marker}-customer@example.invalid`,
    "external-only replacement quote recipient");

  // External PO receipts attach a direct external-job-part instead of stock.
  // That is still charge-changing work: it must invalidate the exact approval,
  // create only one line for a retried receipt, and never be "credited" as an
  // internal stock return.
  const supplier = await pool.query<{ id: number }>(
    `insert into suppliers (dealer_id, name, status) values ($1, $2, 'active') returning id`,
    [dealerId, `${marker} External supplier`],
  );
  const externalRequisition = await pool.query<{ id: number }>(
    `insert into part_requisitions
       (dealer_id, service_order_id, job_card_id, requester_user_id, requester_name, status, urgency)
     values ($1, $2, $3, $4, $5, 'ordered', 'routine') returning id`,
    [dealerId, approval.orderId, approval.cardId, managerUserId, `${marker} Manager`],
  );
  const externalReqLine = await pool.query<{ id: number }>(
    `insert into part_requisition_lines
       (dealer_id, requisition_id, source, description_snapshot, supplier_snapshot, quantity, unit_cost, unit_price)
     values ($1, $2, 'EXTERNAL', $3, $4, 1, 75, 125) returning id`,
    [dealerId, externalRequisition.rows[0]!.id, `${marker} External mirror`, `${marker} External supplier`],
  );
  const externalPo = await pool.query<{ id: number }>(
    `insert into purchase_orders (dealer_id, supplier_id, status, expected_date, reference)
     values ($1, $2, 'ordered', $3, $4) returning id`,
    [dealerId, supplier.rows[0]!.id, today, `${marker}-EXTERNAL-PO`],
  );
  const externalPoLine = await pool.query<{ id: number }>(
    `insert into purchase_order_lines
       (dealer_id, purchase_order_id, source, part_name, quantity, qty_received, unit_cost, job_card_id)
     values ($1, $2, 'EXTERNAL', $3, 1, 0, 75, $4) returning id`,
    [dealerId, externalPo.rows[0]!.id, `${marker} External mirror`, approval.cardId],
  );
  await pool.query(
    `insert into part_requisition_po_allocations
       (dealer_id, requisition_id, requisition_line_id, supplier_id, purchase_order_id, purchase_order_line_id,
        idempotency_key, quantity_ordered, quantity_received)
     values ($1, $2, $3, $4, $5, $6, $7, 1, 0)`,
    [
      dealerId,
      externalRequisition.rows[0]!.id,
      externalReqLine.rows[0]!.id,
      supplier.rows[0]!.id,
      externalPo.rows[0]!.id,
      externalPoLine.rows[0]!.id,
      `${marker}-external-allocation`,
    ],
  );
  const externalReceiptPayload = {
    idempotencyKey: `${marker}-external-receipt`,
    receivedAt: new Date().toISOString(),
    deliveryNoteNumber: `${marker}-DN-EXT`,
    warehouseLocation: "External supplier",
    condition: "accepted",
    documents: [{
      objectPath: `/objects/uploads/dealer-${dealerId}/${marker}-external-receipt.pdf`,
      fileName: "external-receipt.pdf",
      mimeType: "application/pdf",
    }],
    lines: [{ lineId: externalPoLine.rows[0]!.id, qty: 1 }],
  };
  const externalReceipt = await api(`/purchase-orders/${externalPo.rows[0]!.id}/receive`, managerEmail, dealerId, {
    method: "POST",
    body: JSON.stringify(externalReceiptPayload),
  });
  expectStatus(externalReceipt, 200, "external PO receipt");
  const externalReplay = await api(`/purchase-orders/${externalPo.rows[0]!.id}/receive`, managerEmail, dealerId, {
    method: "POST",
    body: JSON.stringify(externalReceiptPayload),
  });
  assert(
    externalReplay.response.status === 200 || externalReplay.response.status === 422,
    "external PO retry returned an unexpected result",
  );
  const externalEffects = await pool.query<{
    count: string;
    estimate_version: number;
    estimate_approved_version: number | null;
    invalidated: string;
  }>(
    `select
       (select count(*) from external_job_card_parts where dealer_id=$1 and job_card_id=$2)::text count,
       (select estimate_version from job_cards where dealer_id=$1 and id=$2) estimate_version,
       (select estimate_approved_version from job_cards where dealer_id=$1 and id=$2) estimate_approved_version,
       (select count(*) from service_estimate_decisions where dealer_id=$1 and job_card_id=$2 and invalidated_at is not null)::text invalidated`,
    [dealerId, approval.cardId],
  );
  equal(Number(externalEffects.rows[0]!.count), 1, "external receipt retry duplicated direct job part");
  assert(externalEffects.rows[0]!.estimate_version > 2, "external receipt did not create a revised estimate version");
  assert(
    externalEffects.rows[0]!.estimate_approved_version !== externalEffects.rows[0]!.estimate_version,
    "external receipt retained stale customer approval",
  );
  assert(Number(externalEffects.rows[0]!.invalidated) >= 1,
    "external receipt did not invalidate prior estimate token",
  );

   // Receiving an internal PO may automatically fill a previously quoted
   // backorder and release a paused card into in-progress, but must never
   // start its timer or complete it. Receipt is
  // fulfillment (not a second charge), so it must not mutate the already
  // approved estimate version or duplicate stock movements.
  const backorderPart = await pool.query<{ id: number }>(
    `insert into parts (dealer_id, sku, name, stock, reorder_level, unit_price, unit_cost, status)
     values ($1, $2, $3, 0, 0, 80, 40, 'active') returning id`,
    [dealerId, `${marker}-BACKORDER`, `${marker} Backorder component`],
  );
  const backorder = await orderAndCard({
    label: "Backorder auto-resume vehicle",
    scheduledDate: yesterday,
    status: "on_hold",
    waitingReason: "ordered_parts",
    quoteTotal: 91.2,
  });
  await pool.query(
    `update job_cards
        set estimate_version=1, estimate_approved_version=null,
            estimate_approval_at=null, estimate_approval_evidence=null,
            estimate_staff_acknowledged_version=null,
            estimate_staff_acknowledged_decision_id=null,
            estimate_staff_acknowledged_by_user_id=null,
            estimate_staff_acknowledged_by_name=null,
            estimate_staff_acknowledged_at=null
      where id=$1 and dealer_id=$2`,
    [backorder.cardId, dealerId],
  );
  await pool.query(
    `insert into job_card_parts
       (dealer_id, job_card_id, part_id, part_name, kind, quantity, unit_price, unit_cost, backordered)
     values ($1, $2, $3, $4, 'issue', 1, 80, 40, true)`,
    [dealerId, backorder.cardId, backorderPart.rows[0]!.id, `${marker} Backorder component`],
  );
  // Auto-resume is still real chargeable work. Seed a genuine current
  // customer decision and its separate staff receipt, rather than treating
  // the legacy `estimate_approved_version` flag as sufficient authorization.
  const backorderApprovalToken = token();
  await pool.query(
    `insert into service_estimate_decisions
       (dealer_id, service_order_id, job_card_id, token_hash, estimate_total, lines_snapshot,
        estimate_version, expires_at)
     values ($1, $2, $3, $4, 91.2, $5::jsonb, 1, now() + interval '1 hour')`,
    [
      dealerId,
      backorder.orderId,
      backorder.cardId,
      tokenHash(backorderApprovalToken),
      JSON.stringify([
        { kind: "part", description: `${marker} Backorder component`, quantity: 1, amount: 80 },
        { kind: "tax", description: "Tax", quantity: 1, amount: 11.2 },
      ]),
    ],
  );
  const backorderCustomerApproval = await api(
    `/service-estimates/${backorderApprovalToken}`,
    null,
    dealerId,
    { method: "POST", body: JSON.stringify({ decision: "approved" }) },
  );
  expectStatus(backorderCustomerApproval, 200, "backorder current customer approval");
  const backorderStaffAcknowledgement = await api(
    `/job-cards/${backorder.cardId}/estimate/acknowledge`,
    managerEmail,
    dealerId,
    { method: "POST" },
  );
  expectStatus(backorderStaffAcknowledgement, 200, "backorder current staff acknowledgement");
  const internalPo = await pool.query<{ id: number }>(
    `insert into purchase_orders (dealer_id, supplier_id, status, expected_date, reference)
     values ($1, $2, 'ordered', $3, $4) returning id`,
    [dealerId, supplier.rows[0]!.id, today, `${marker}-INTERNAL-PO`],
  );
  const internalPoLine = await pool.query<{ id: number }>(
    `insert into purchase_order_lines
       (dealer_id, purchase_order_id, source, part_id, part_name, quantity, qty_received, unit_cost, job_card_id)
     values ($1, $2, 'INTERNAL', $3, $4, 1, 0, 40, $5) returning id`,
    [
      dealerId,
      internalPo.rows[0]!.id,
      backorderPart.rows[0]!.id,
      `${marker} Backorder component`,
      backorder.cardId,
    ],
  );
  const internalReceipt = await api(`/purchase-orders/${internalPo.rows[0]!.id}/receive`, managerEmail, dealerId, {
    method: "POST",
    body: JSON.stringify({
      idempotencyKey: `${marker}-internal-receipt`,
      receivedAt: new Date().toISOString(),
      deliveryNoteNumber: `${marker}-DN-INT`,
      warehouseLocation: "Parts counter",
      condition: "accepted",
      documents: [{
        objectPath: `/objects/uploads/dealer-${dealerId}/${marker}-internal-receipt.pdf`,
        fileName: "internal-receipt.pdf",
        mimeType: "application/pdf",
      }],
      lines: [{ lineId: internalPoLine.rows[0]!.id, qty: 1 }],
    }),
  });
  expectStatus(internalReceipt, 200, "internal PO backorder receipt");
  const backorderEffects = await pool.query<{
    status: string;
    backordered: boolean;
    stock: string;
    estimate_version: number;
    estimate_approved_version: number | null;
    timer_started_at: Date | null;
  }>(
    `select
       (select status from job_cards where id=$1 and dealer_id=$2) status,
       (select backordered from job_card_parts where dealer_id=$2 and job_card_id=$1 and part_id=$3 and kind='issue') backordered,
       (select stock::text from parts where dealer_id=$2 and id=$3) stock,
       (select estimate_version from job_cards where id=$1 and dealer_id=$2) estimate_version,
        (select estimate_approved_version from job_cards where id=$1 and dealer_id=$2) estimate_approved_version,
        (select timer_started_at from job_cards where id=$1 and dealer_id=$2) timer_started_at`,
    [backorder.cardId, dealerId, backorderPart.rows[0]!.id],
  );
  equal(backorderEffects.rows[0]!.status, "in_progress", "backorder receipt did not resume active work");
  equal(backorderEffects.rows[0]!.timer_started_at, null,
    "backorder receipt started a timer instead of requiring explicit technician resume");
  equal(backorderEffects.rows[0]!.backordered, false, "backorder line was not fulfilled");
  equal(Number(backorderEffects.rows[0]!.stock), 0, "backorder receipt/issue changed stock twice");
  equal(backorderEffects.rows[0]!.estimate_version, 1,
    "backorder fulfillment incorrectly changed an already quoted estimate");
  equal(backorderEffects.rows[0]!.estimate_approved_version, 1,
    "backorder fulfillment incorrectly removed current customer approval");

  // One receipt may release several cards. This deliberately includes an
  // unassigned card and two cards for a technician who is already busy: stock
  // fulfillment must succeed and release their workflow state, but it must
  // never try to auto-start any timer (which would roll back the receipt under
  // the technician timer concurrency backstop).
  const releaseSafetyPart = await pool.query<{ id: number }>(
    `insert into parts (dealer_id, sku, name, stock, reorder_level, unit_price, unit_cost, status)
     values ($1, $2, $3, 0, 0, 80, 40, 'active') returning id`,
    [dealerId, `${marker}-RELEASE-SAFETY`, `${marker} receipt safety component`],
  );
  const unassignedRelease = await orderAndCard({
    label: "Unassigned receipt release",
    scheduledDate: yesterday,
    status: "on_hold",
    waitingReason: "ordered_parts",
    technician: false,
  });
  const busyRelease = await orderAndCard({
    label: "Busy technician receipt release",
    scheduledDate: yesterday,
    status: "on_hold",
    waitingReason: "ordered_parts",
  });
  const sameTechnicianRelease = await orderAndCard({
    label: "Second busy technician receipt release",
    scheduledDate: yesterday,
    status: "on_hold",
    waitingReason: "ordered_parts",
  });
  for (const cardId of [
    unassignedRelease.cardId,
    busyRelease.cardId,
    sameTechnicianRelease.cardId,
  ]) {
    await pool.query(
      `insert into job_card_parts
         (dealer_id, job_card_id, part_id, part_name, kind, quantity, unit_price, unit_cost, backordered)
       values ($1, $2, $3, $4, 'issue', 1, 80, 40, true)`,
      [dealerId, cardId, releaseSafetyPart.rows[0]!.id, `${marker} receipt safety component`],
    );
  }
  // The first receipt release card is now safely in-progress but paused.
  // Earlier fixture cases can legitimately have left one timer running. End
  // that real timer through its normal endpoint before making this card the
  // sole busy timer for the second receipt; do not bypass the timer guard with
  // fixture SQL.
  const priorRunningTimers = await pool.query<{ id: number }>(
    `select id from job_cards
      where dealer_id=$1 and technician_user_id=$2 and timer_started_at is not null
      order by id`,
    [dealerId, technicianUserId],
  );
  assert(priorRunningTimers.rows.length <= 1,
    "fixture created more than one running timer for the technician");
  if (priorRunningTimers.rows[0]) {
    const pausePriorTimer = await api(
      `/job-cards/${priorRunningTimers.rows[0].id}/timer`,
      technicianEmail,
      dealerId,
      { method: "POST", body: JSON.stringify({ action: "pause" }) },
    );
    expectStatus(pausePriorTimer, 200, "pause prior fixture timer before busy receipt");
  }
  // Make it the only busy timer for this technician before the second receipt.
  await pool.query(
    `update job_cards set timer_started_at = now()
      where dealer_id = $1 and id = $2`,
    [dealerId, backorder.cardId],
  );
  const releaseSafetyPo = await pool.query<{ id: number }>(
    `insert into purchase_orders (dealer_id, supplier_id, status, expected_date, reference)
     values ($1, $2, 'ordered', $3, $4) returning id`,
    [dealerId, supplier.rows[0]!.id, today, `${marker}-RELEASE-SAFETY-PO`],
  );
  const releaseSafetyLine = await pool.query<{ id: number }>(
    `insert into purchase_order_lines
       (dealer_id, purchase_order_id, source, part_id, part_name, quantity, qty_received, unit_cost, job_card_id)
     values ($1, $2, 'INTERNAL', $3, $4, 3, 0, 40, $5) returning id`,
    [
      dealerId,
      releaseSafetyPo.rows[0]!.id,
      releaseSafetyPart.rows[0]!.id,
      `${marker} receipt safety component`,
      busyRelease.cardId,
    ],
  );
  const releaseSafetyReceipt = await api(
    `/purchase-orders/${releaseSafetyPo.rows[0]!.id}/receive`,
    managerEmail,
    dealerId,
    {
      method: "POST",
      body: JSON.stringify({
        idempotencyKey: `${marker}-release-safety-receipt`,
        receivedAt: new Date().toISOString(),
        deliveryNoteNumber: `${marker}-DN-RELEASE-SAFETY`,
        warehouseLocation: "Parts counter",
        condition: "accepted",
        documents: [{
          objectPath: `/objects/uploads/dealer-${dealerId}/${marker}-release-safety.pdf`,
          fileName: "release-safety.pdf",
          mimeType: "application/pdf",
        }],
        lines: [{ lineId: releaseSafetyLine.rows[0]!.id, qty: 3 }],
      }),
    },
  );
  expectStatus(releaseSafetyReceipt, 200,
    "receipt releases unassigned and busy/multiple-technician backorders");
  const releaseSafetyEffects = await pool.query<{
    id: number;
    status: string;
    timer_started_at: Date | null;
    technician_user_id: number | null;
    backordered: boolean;
  }>(
    `select c.id, c.status, c.timer_started_at, c.technician_user_id, p.backordered
       from job_cards c
       join job_card_parts p on p.job_card_id = c.id and p.dealer_id = c.dealer_id
      where c.dealer_id = $1 and c.id = any($2::int[]) and p.part_id = $3
      order by c.id`,
    [
      dealerId,
      [unassignedRelease.cardId, busyRelease.cardId, sameTechnicianRelease.cardId],
      releaseSafetyPart.rows[0]!.id,
    ],
  );
  equal(releaseSafetyEffects.rows.length, 3,
    "receipt did not retain all released backorder lines");
  for (const effect of releaseSafetyEffects.rows) {
    equal(effect.status, "in_progress", "receipt did not release a fully stocked backorder");
    equal(effect.timer_started_at, null, "receipt auto-started a released job-card timer");
    equal(effect.backordered, false, "receipt did not fulfill a released backorder line");
  }
  const busyTimerAfterReceipt = await pool.query<{ timer_started_at: Date | null }>(
    `select timer_started_at from job_cards where dealer_id=$1 and id=$2`,
    [dealerId, backorder.cardId],
  );
  assert(busyTimerAfterReceipt.rows[0]!.timer_started_at,
    "receipt changed the technician's unrelated running timer");

  // Tenant checks remain opaque even for the same fixture customer id. The
  // manager only belongs to dealerId and must not read a foreign job card.
  const foreignOrder = await pool.query<{ id: number }>(
    `insert into service_orders
       (dealer_id, customer_name, vehicle_info, scheduled_date, status, created_origin)
     values ($1, $2, $3, $4, 'acknowledged', 'system') returning id`,
    [otherDealerId, `${marker} Foreign customer`, `${marker} Foreign vehicle`, today],
  );
  const foreignCard = await pool.query<{ id: number }>(
    `insert into job_cards (dealer_id, service_order_id, title, status)
     values ($1, $2, $3, 'open') returning id`,
    [otherDealerId, foreignOrder.rows[0]!.id, `${marker} Foreign card`],
  );
  const foreignRead = await api(`/job-cards/${foreignCard.rows[0]!.id}`, managerEmail, dealerId);
  expectStatus(foreignRead, 404, "cross-tenant job card read");
  const foreignPreview = await api(
    `/job-cards/${foreignCard.rows[0]!.id}/estimate/preview`,
    managerEmail,
    dealerId,
  );
  expectStatus(foreignPreview, 404, "cross-tenant estimate preview");

  if (assertionFailures.length) {
    throw new Error(
      `Workshop carryover/customer approval verification found ${assertionFailures.length} assertion failure(s):\n` +
      assertionFailures.map((failure, index) => `${index + 1}. ${failure}`).join("\n"),
    );
  }
  console.log("Workshop carryover/customer approval verification passed.");
} finally {
  await cleanup().catch((error) => {
    console.error("Workshop carryover verification cleanup failed", error);
  });
  await pool.end();
}