/**
 * Development PostgreSQL regression for service-confirmation preflight.
 *
 * The Graph API is replaced with an in-process fetch mock. This exercises the
 * real WhatsApp outbox worker against fixture rows while proving that GET
 * timeouts/429/5xx do not trigger a POST or consume the explicit retry's one
 * authorized provider handoff.
 */
import assert from "node:assert/strict";

function refuse(reason: string): never {
  console.error(
    `test-service-appointment-confirmation-worker refuses to run: ${reason}`,
  );
  process.exit(1);
}

if (process.env.NODE_ENV === "production") {
  refuse("NODE_ENV=production — this is a dev-only fixture suite.");
}
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
delete process.env.OUTBOX_WORKER_DISABLED;
process.env.WHATSAPP_GRAPH_BASE_URL = "https://mock-whatsapp-graph.test/v21.0";
process.env.WHATSAPP_ACCESS_TOKEN = "worker-fixture-token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "worker-phone";
process.env.WHATSAPP_WABA_ID = "worker-waba";

{
  const raw = process.env.DATABASE_URL ?? process.env.DEV_DATABASE_URL;
  if (!raw) refuse("DEV_DATABASE_URL or DATABASE_URL is not set.");
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    refuse("The development database URL is not parseable.");
  }
  const allowedHosts = new Set(["helium", "localhost", "127.0.0.1"]);
  if (process.env.PGHOST) allowedHosts.add(process.env.PGHOST.toLowerCase());
  if (
    process.env.PGHOST &&
    !["helium", "localhost", "127.0.0.1"].includes(
      process.env.PGHOST.toLowerCase(),
    )
  ) {
    allowedHosts.delete(process.env.PGHOST.toLowerCase());
  }
  if (!allowedHosts.has(host)) {
    refuse(
      `DATABASE_URL host "${host}" is not the allowlisted development database (helium/localhost).`,
    );
  }
  if (process.env.PROD_DATABASE_URL) {
    try {
      const prod = new URL(process.env.PROD_DATABASE_URL);
      const dev = new URL(raw);
      if (prod.hostname === dev.hostname && prod.pathname === dev.pathname) {
        refuse("The development database URL matches PROD_DATABASE_URL.");
      }
    } catch {
      // The host allowlist remains the fail-closed boundary.
    }
  }
}

const {
  SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE,
  renderServiceAppointmentConfirmedBody,
} = await import("../lib/service-appointment-whatsapp");
const { db, emailLogsTable, pool } = await import("@workspace/db");
const { eq } = await import("drizzle-orm");
const { processQueue } = await import("../lib/email");

const fixture = `service-confirmation-worker:${process.pid}:${Date.now()}`;
const recipient = "5926001234";
const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID!;
const wabaId = process.env.WHATSAPP_WABA_ID!;
const appointmentScheduledAt = "2026-09-17T13:00:00.000Z";
const bodyParameters = [
  "Alex Mensah",
  "Main Service Centre",
  "RO-WORKER",
  "maintenance",
  "September 17, 2026",
  "9:00 AM",
  "2025 BYD Seal",
  "PXX 1234",
] as const;
const body = renderServiceAppointmentConfirmedBody(bodyParameters);
const transientOutcomes = ["timeout", 429, 500] as const;
let diagnosticAttempt = 0;
let providerPostCalls = 0;

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  const method = init?.method ?? "GET";
  if (method === "POST") {
    providerPostCalls += 1;
    return jsonResponse({ messages: [{ id: "wamid.worker-fixture" }] });
  }
  if (method !== "GET") {
    throw new Error(`unexpected mocked Graph method: ${method}`);
  }

  const outcome = transientOutcomes[diagnosticAttempt] ?? "ready";
  if (outcome === "timeout") {
    if (url.includes("message_templates")) diagnosticAttempt += 1;
    throw new Error("mock Graph network timeout");
  }
  const transientStatus =
    typeof outcome === "number" ? outcome : outcome === "ready" ? 200 : null;
  if (transientStatus !== 200) {
    if (url.includes("message_templates")) diagnosticAttempt += 1;
    return jsonResponse({ error: { code: transientStatus === 429 ? 80001 : 2 } }, transientStatus!);
  }

  if (url.includes(`/${phoneNumberId}?fields=`)) {
    return jsonResponse({
      platform_type: "CLOUD_API",
      status: "CONNECTED",
    });
  }
  if (url.includes(`/${wabaId}/phone_numbers?fields=id&limit=100`)) {
    return jsonResponse({ data: [{ id: phoneNumberId }] });
  }
  if (url.includes(`/${wabaId}/message_templates?`)) {
    diagnosticAttempt += 1;
    return jsonResponse({
      data: [
        {
          name: SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE.name,
          language: SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE.language,
          status: "APPROVED",
          components: [
            {
              type: "HEADER",
              format: "TEXT",
              text: SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE.header,
            },
            {
              type: "BODY",
              text: SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE.body,
            },
          ],
        },
      ],
    });
  }
  throw new Error(`unexpected mocked Graph URL: ${url}`);
};

let dealerId = 0;
let serviceOrderId = 0;
let jobCardId = 0;
let outboxId = 0;
const dedupeKey = `${fixture}:dedupe`;

async function readOutbox() {
  const [row] = await db
    .select()
    .from(emailLogsTable)
    .where(eq(emailLogsTable.id, outboxId));
  assert.ok(row, "fixture outbox row exists");
  return row;
}

try {
  dealerId = (
    await pool.query(
      "insert into dealers (name, status) values ($1, 'active') returning id",
      [`Worker Fixture ${fixture}`],
    )
  ).rows[0].id as number;
  process.env.WHATSAPP_DEALER_ID = String(dealerId);

  serviceOrderId = (
    await pool.query(
      `insert into service_orders
         (dealer_id, vehicle_info, status, scheduled_date, type)
       values ($1, '2025 BYD Seal', 'acknowledged', '2026-09-17', 'maintenance')
       returning id`,
      [dealerId],
    )
  ).rows[0].id as number;
  jobCardId = (
    await pool.query(
      `insert into job_cards
         (dealer_id, service_order_id, title, scheduled_at)
       values ($1, $2, 'Worker fixture appointment', $3)
       returning id`,
      [dealerId, serviceOrderId, appointmentScheduledAt],
    )
  ).rows[0].id as number;

  const [row] = await db
    .insert(emailLogsTable)
    .values({
      dealerId,
      recipient,
      subject: "Service Appointment Confirmed",
      template: "service.appointment.confirmed",
      channel: "whatsapp",
      status: "queued",
      deliveryStatus: "queued",
      attempts: 2,
      nextAttemptAt: new Date(),
      payload: {
        body,
        serviceOrderId: String(serviceOrderId),
        appointmentScheduledAt,
        whatsappTemplateName: SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE.name,
        whatsappTemplateLanguage: SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE.language,
        whatsappTemplateBodyParametersJson: JSON.stringify(bodyParameters),
      },
      dedupeKey,
    })
    .returning();
  assert.ok(row, "fixture outbox row was inserted");
  outboxId = row.id;

  for (const outcome of transientOutcomes) {
    await processQueue();
    const deferred = await readOutbox();
    assert.equal(
      deferred.status,
      "failed",
      `preflight ${String(outcome)} is retryable`,
    );
    assert.equal(deferred.attempts, 2, "preflight does not consume the authorized send");
    assert.equal(deferred.providerMessageId, null, "no provider id before readiness");
    assert.equal(deferred.dedupeKey, dedupeKey, "dedupe key remains stable");
    assert.equal(
      deferred.payload?.whatsappProviderOutcome,
      undefined,
      "preflight does not poison provider outcome state",
    );
    assert.equal(providerPostCalls, 0, "no provider POST occurs before readiness");
    assert.ok(
      deferred.nextAttemptAt && deferred.nextAttemptAt > new Date(),
      "preflight is backed off for a later worker pass",
    );
    await pool.query(
      "update email_logs set next_attempt_at = now() where id = $1",
      [outboxId],
    );
  }

  await processQueue();
  const sent = await readOutbox();
  assert.equal(sent.status, "sent", "successful readiness permits the handoff");
  assert.equal(sent.attempts, 3, "the successful handoff consumes the explicit send budget");
  assert.equal(sent.providerMessageId, "wamid.worker-fixture");
  assert.equal(sent.dedupeKey, dedupeKey);
  assert.equal(providerPostCalls, 1, "exactly one mocked provider POST occurs");
  assert.equal(diagnosticAttempt, 4, "three transient checks precede one successful check");

  console.log(
    "PASS: service appointment worker defers transient template preflight failures.",
  );
} finally {
  globalThis.fetch = originalFetch;
  try {
    if (outboxId) {
      await pool.query("delete from email_logs where id = $1", [outboxId]);
    }
    if (jobCardId) {
      await pool.query("delete from job_cards where id = $1", [jobCardId]);
    }
    if (serviceOrderId) {
      await pool.query("delete from service_orders where id = $1", [serviceOrderId]);
    }
    if (dealerId) {
      await pool.query("delete from dealers where id = $1", [dealerId]);
    }
  } finally {
    await pool.end();
  }
}