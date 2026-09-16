/**
 * Development-only regression for the single explicit service-confirmation
 * replay. It uses fixture outbox rows and disables the worker, so it never
 * hands a message to Meta.
 */
import assert from "node:assert/strict";

function refuse(reason: string): never {
  console.error(`test-service-appointment-confirmation-retry refuses to run: ${reason}`);
  process.exit(1);
}

if (process.env.NODE_ENV === "production") {
  refuse("NODE_ENV=production — this suite only writes disposable development fixtures.");
}
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.OUTBOX_WORKER_DISABLED = "1";

const rawDatabaseUrl = process.env.DATABASE_URL ?? process.env.DEV_DATABASE_URL;
if (!rawDatabaseUrl) refuse("DEV_DATABASE_URL or DATABASE_URL is not set.");
let databaseHost: string;
try {
  databaseHost = new URL(rawDatabaseUrl).hostname.toLowerCase();
} catch {
  refuse("The development database URL is not parseable.");
}
const allowedHosts = new Set(["helium", "localhost", "127.0.0.1"]);
if (process.env.PGHOST) allowedHosts.add(process.env.PGHOST.toLowerCase());
if (!allowedHosts.has(databaseHost)) {
  refuse(`DATABASE_URL host "${databaseHost}" is not an allowlisted development database.`);
}

const { eq } = await import("drizzle-orm");
const { db, emailLogsTable, pool, whatsappMessagesTable } = await import(
  "@workspace/db"
);
const {
  isDefinitivelyRejectedWhatsapp,
  retryRejectedWhatsappOutboxItem,
} = await import("../lib/email");
const { renderServiceAppointmentConfirmedBody } = await import(
  "../lib/service-appointment-whatsapp"
);

const fixture = `service-confirmation-retry:${process.pid}:${Date.now()}`;
let ownerDealerId = 0;
let otherDealerId = 0;
const originalBodyParameters = [
  "Alex Mensah",
  "Main Service Centre",
  "RO-00118",
  "maintenance",
  "September 17, 2026",
  "9:00 AM",
  "2025 BYD Seal",
  "PXX 1234",
] as const;

async function createDealer(name: string): Promise<number> {
  const result = await pool.query(
    "insert into dealers (name, status) values ($1, 'active') returning id",
    [name],
  );
  return result.rows[0].id as number;
}

async function insertRejected(dealerId: number, suffix: string) {
  const [row] = await db.insert(emailLogsTable).values({
    dealerId,
    recipient: "5926001234",
    subject: "Service Appointment Confirmed",
    template: "service.appointment.confirmed",
    channel: "whatsapp",
    status: "failed",
    deliveryStatus: "failed",
    attempts: 3,
    lastError: "WhatsApp Graph API 404",
    payload: {
      // Simulate a legacy failed row whose persisted transcript still uses
      // the pre-approval copy. The retry must rebuild it from these values.
      body:
        "Hi Alex Mensah, your service appointment at Main Service Centre is confirmed. " +
        "Thank you for choosing Main Service Centre.",
      serviceOrderId: "118",
      appointmentScheduledAt: "2026-09-17T13:00:00.000Z",
      whatsappTemplateName: "service_appointment_confirmed",
      whatsappTemplateLanguage: "en",
      whatsappTemplateBodyParametersJson: JSON.stringify(originalBodyParameters),
    },
    dedupeKey: `${fixture}:${suffix}`,
  }).returning();
  assert.ok(row, "fixture rejected row was inserted");
  return row;
}

try {
  ownerDealerId = await createDealer(`Retry Owner ${fixture}`);
  otherDealerId = await createDealer(`Retry Other ${fixture}`);
  const rejected = await insertRejected(ownerDealerId, "one");
  await db.insert(whatsappMessagesTable).values({
    dealerId: ownerDealerId,
    phone: "5926001234",
    direction: "out",
    body: rejected.payload?.body ?? "",
    outboxId: rejected.id,
    deliveryStatus: "failed",
  });

  assert.equal(isDefinitivelyRejectedWhatsapp(rejected), true, "404 is a known rejection");
  assert.equal(
    isDefinitivelyRejectedWhatsapp({
      ...rejected,
      status: "sent",
      deliveryStatus: "accepted",
      providerMessageId: "wamid.accepted",
    }),
    false,
    "accepted messages cannot be replayed",
  );
  assert.equal(
    isDefinitivelyRejectedWhatsapp({
      ...rejected,
      payload: {
        ...rejected.payload,
        whatsappProviderOutcome: "uncertain",
      },
      lastError: "WhatsApp Graph API 404",
    }),
    false,
    "a later uncertain handoff overrides an earlier rejection",
  );
  assert.equal(
    isDefinitivelyRejectedWhatsapp({
      ...rejected,
      lastError: "WhatsApp provider request outcome is unknown",
    }),
    false,
    "uncertain messages cannot be replayed",
  );

  const denied = await retryRejectedWhatsappOutboxItem({
    id: rejected.id,
    dealerId: otherDealerId,
  });
  assert.equal(denied, null, "a dealer cannot replay another dealer's row");

  const race = await Promise.all([
    retryRejectedWhatsappOutboxItem({
      id: rejected.id,
      dealerId: ownerDealerId,
    }),
    retryRejectedWhatsappOutboxItem({
      id: rejected.id,
      dealerId: ownerDealerId,
    }),
  ]);
  assert.equal(race.filter(Boolean).length, 1, "only one concurrent click can requeue");
  const [stored] = await db
    .select()
    .from(emailLogsTable)
    .where(eq(emailLogsTable.id, rejected.id));
  assert.ok(stored);
  assert.equal(stored.status, "queued");
  assert.equal(stored.deliveryStatus, "queued");
  assert.equal(stored.attempts, 2, "one remaining provider handoff is allowed");
  assert.equal(stored.dedupeKey, rejected.dedupeKey, "the dedupe key remains stable");
  assert.equal(
    stored.payload?.body,
    renderServiceAppointmentConfirmedBody(originalBodyParameters),
    "retry rerenders the transcript from the validated original parameters",
  );
  assert.match(
    stored.payload?.body ?? "",
    /Booking reference: RO-00118/,
  );
  assert.doesNotMatch(
    stored.payload?.body ?? "",
    /Thank you for choosing/,
  );
  const [transcript] = await db
    .select()
    .from(whatsappMessagesTable)
    .where(eq(whatsappMessagesTable.outboxId, rejected.id));
  assert.equal(
    transcript?.body,
    renderServiceAppointmentConfirmedBody(originalBodyParameters),
    "retry updates the saved transcript copy as well",
  );

  // A sequential click after an operator retry must never create a second
  // provider handoff, even if the retry later ends in another Meta 4xx.
  await db
    .update(emailLogsTable)
    .set({
      status: "failed",
      deliveryStatus: "failed",
      attempts: 3,
      lastError: "WhatsApp Graph API 404",
      payload: {
        ...stored.payload,
        whatsappProviderOutcome: "rejected",
      },
    })
    .where(eq(emailLogsTable.id, rejected.id));
  const sequential = await retryRejectedWhatsappOutboxItem({
    id: rejected.id,
    dealerId: ownerDealerId,
  });
  assert.equal(sequential, null, "the explicit retry marker is consumed permanently");

  console.log("PASS: service appointment confirmation retry safety.");
} finally {
  try {
    if (ownerDealerId) {
      await pool.query("delete from email_logs where dealer_id = $1", [ownerDealerId]);
      await pool.query("delete from whatsapp_messages where dealer_id = $1", [
        ownerDealerId,
      ]);
    }
    if (otherDealerId) {
      await pool.query("delete from email_logs where dealer_id = $1", [otherDealerId]);
      await pool.query("delete from whatsapp_messages where dealer_id = $1", [
        otherDealerId,
      ]);
    }
    if (ownerDealerId) await pool.query("delete from dealers where id = $1", [ownerDealerId]);
    if (otherDealerId) await pool.query("delete from dealers where id = $1", [otherDealerId]);
  } finally {
    await pool.end();
  }
}