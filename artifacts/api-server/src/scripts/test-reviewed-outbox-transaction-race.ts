/**
 * Development PostgreSQL regression for reviewed-import/outbox serialization.
 * It uses only fixture outbox rows and no SMTP/Meta transport.
 */
import assert from "node:assert/strict";

// This guard must run before any import that can initialize the DB pool. ESM
// static imports are hoisted, hence every application dependency is dynamic.
function refuse(reason: string): never {
  console.error(`test-reviewed-outbox-transaction-race refuses to run: ${reason}`);
  process.exit(1);
}
if (process.env.NODE_ENV === "production") {
  refuse("NODE_ENV=production — this is a dev-only fixture suite.");
}
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.OUTBOX_WORKER_DISABLED = "1";
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
      // The hostname allowlist above remains the fail-closed boundary.
    }
  }
}

const { eq } = await import("drizzle-orm");
const { db, emailLogsTable, pool } = await import("@workspace/db");
const {
  recoverClaimedOutboxItem,
  withReviewedOutboxCommunicationLock,
} = await import("../lib/email");
const {
  reviewedOutboxCommunicationLockKeys,
} = await import("../lib/reviewed-delivery-import-policy");

type EmailLog = typeof emailLogsTable.$inferSelect;
const fixtureId = `reviewed-outbox-race:${process.pid}:${Date.now()}`;
let dealerId = 0;
let leadId = 0;
let customerId = 0;

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixtureItem(row: EmailLog): Pick<
  EmailLog,
  "id" | "channel" | "customerId" | "dealerId" | "leadId" | "payload" | "recipient"
> {
  return row;
}

async function seedFixtureIdentity(): Promise<void> {
  dealerId = (
    await pool.query(
      `insert into dealers (name, status) values ($1, 'active') returning id`,
      [`Verify Reviewed Outbox ${fixtureId}`],
    )
  ).rows[0].id as number;
  customerId = (
    await pool.query(
      `insert into customers (dealer_id, name, email, phone)
       values ($1, $2, $3, $4) returning id`,
      [
        dealerId,
        `Verify Reviewed Customer ${fixtureId}`,
        "reviewed-race@example.test",
        "5926001234",
      ],
    )
  ).rows[0].id as number;
  leadId = (
    await pool.query(
      `insert into leads (dealer_id, customer_id, name, email, phone)
       values ($1, $2, $3, $4, $5) returning id`,
      [
        dealerId,
        customerId,
        `Verify Reviewed Lead ${fixtureId}`,
        "reviewed-race@example.test",
        "5926001234",
      ],
    )
  ).rows[0].id as number;
}

async function beginImportFence(
  item: EmailLog,
): Promise<{
  cancelFixtureOutbox: (id: number) => Promise<void>;
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
}> {
  const client = await pool.connect();
  const keys = reviewedOutboxCommunicationLockKeys({
    dealerId: item.dealerId,
    leadId: item.leadId,
    customerId: item.customerId,
    email: item.channel === "email" ? item.recipient : null,
    whatsappPhones: item.channel === "whatsapp" ? [item.recipient] : undefined,
  });
  await client.query("BEGIN");
  try {
    // This exactly mirrors the import's transaction-scoped lock operation.
    for (const key of keys) {
      await client.query(
        "select pg_advisory_xact_lock(hashtext($1))",
        [key],
      );
    }
  } catch (error) {
    await client.query("ROLLBACK");
    client.release();
    throw error;
  }
  return {
    cancelFixtureOutbox: async (id) => {
      // Keep the conversion/cancellation mutation in the same transaction
      // that owns the importer-side xact advisory lock.
      await client.query(
        "update email_logs set status = 'cancelled', next_attempt_at = null where id = $1",
        [id],
      );
    },
    commit: async () => {
      try {
        await client.query("COMMIT");
      } finally {
        client.release();
      }
    },
    rollback: async () => {
      try {
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    },
  };
}

async function insertFixture(
  channel: "email" | "whatsapp",
  suffix: string,
  status: "sending" | "processing",
): Promise<EmailLog> {
  const [row] = await db.insert(emailLogsTable).values({
    dealerId,
    customerId,
    leadId,
    recipient:
      channel === "email" ? "reviewed-race@example.test" : "5926001234",
    subject: "fixture reviewed outbox race",
    template: "outreach",
    channel,
    status,
    attempts: 0,
    payload: {},
    dedupeKey: `${fixtureId}:${channel}:${suffix}`,
    // A running API worker is a separate process, so its in-process disable
    // flag is irrelevant. These claimed fixture states are deliberately not
    // ready for any shared worker to reclaim.
    nextAttemptAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  }).returning();
  assert.ok(row, "fixture outbox row was inserted");
  return row;
}

async function statusOf(id: number): Promise<string> {
  const [row] = await db
    .select({ status: emailLogsTable.status })
    .from(emailLogsTable)
    .where(eq(emailLogsTable.id, id));
  assert.ok(row, "fixture outbox row still exists");
  return row.status;
}

async function retryStateOf(id: number): Promise<{
  status: string;
  attempts: number;
  nextAttemptAt: Date | null;
}> {
  const [row] = await db
    .select({
      status: emailLogsTable.status,
      attempts: emailLogsTable.attempts,
      nextAttemptAt: emailLogsTable.nextAttemptAt,
    })
    .from(emailLogsTable)
    .where(eq(emailLogsTable.id, id));
  assert.ok(row, "fixture retry row still exists");
  return row;
}

async function importFirstCancels(channel: "email" | "whatsapp") {
  const item = await insertFixture(
    channel,
    "import-first",
    channel === "email" ? "sending" : "processing",
  );
  const importer = await beginImportFence(item);
  let workerEntered = false;
  const worker = withReviewedOutboxCommunicationLock(
    fixtureItem(item),
    async () => {
      workerEntered = true;
      // This is the worker's no-send path after its real final provenance
      // lookup observes the reviewed import committed under the same fence.
      assert.equal(await statusOf(item.id), "cancelled");
    },
  );
  await delay(30);
  assert.equal(workerEntered, false, `${channel}: worker waits for import fence`);

  // Fixture equivalent of import conversion cancelling a claimable row,
  // committed under the transaction lock rather than a separate connection.
  await importer.cancelFixtureOutbox(item.id);
  await importer.commit();
  await worker;
  assert.equal(await statusOf(item.id), "cancelled");
}

async function workerFirstBlocksImport(channel: "email" | "whatsapp") {
  const item = await insertFixture(
    channel,
    "worker-first",
    channel === "email" ? "sending" : "processing",
  );
  const providerStarted = deferred();
  const completeProvider = deferred();
  let fakeProviderCalls = 0;
  const worker = withReviewedOutboxCommunicationLock(
    fixtureItem(item),
    async () => {
      providerStarted.resolve();
      await completeProvider.promise; // no-op provider; never sends externally
      fakeProviderCalls += 1;
      await db
        .update(emailLogsTable)
        .set({ status: "sent" })
        .where(eq(emailLogsTable.id, item.id));
    },
  );
  await providerStarted.promise;

  const importAcquired = deferred<Awaited<ReturnType<typeof beginImportFence>>>();
  const importing = beginImportFence(item).then((fence) => {
    importAcquired.resolve(fence);
    return fence;
  });
  await delay(30);
  let importHasLock = false;
  void importAcquired.promise.then(() => { importHasLock = true; });
  await delay(0);
  assert.equal(importHasLock, false, `${channel}: import waits for fake provider`);

  completeProvider.resolve();
  await worker;
  const importer = await importing;
  assert.equal(fakeProviderCalls, 1, `${channel}: fake provider completed once`);
  // The importer acquired only after the send completed, so it does not
  // retroactively cancel an accepted/sent row.
  assert.equal(await statusOf(item.id), "sent");
  await importer.rollback();
}

try {
  await seedFixtureIdentity();
  for (const channel of ["email", "whatsapp"] as const) {
    await importFirstCancels(channel);
    await workerFirstBlocksImport(channel);
  }

  // Exercise the production post-claim recovery operation against real rows.
  const emailClaim = await insertFixture("email", "lookup-failure", "sending");
  await recoverClaimedOutboxItem(
    emailClaim,
    "fixture controlled-import lookup unavailable",
    "sending",
  );
  const emailRetry = await retryStateOf(emailClaim.id);
  assert.equal(emailRetry.status, "failed");
  assert.equal(emailRetry.attempts, 1);
  assert.ok(emailRetry.nextAttemptAt, "email provenance failure has a retry time");

  const whatsappClaim = await insertFixture(
    "whatsapp",
    "lookup-failure",
    "processing",
  );
  await recoverClaimedOutboxItem(
    whatsappClaim,
    "fixture controlled-import lookup unavailable",
    "processing",
  );
  const whatsappRetry = await retryStateOf(whatsappClaim.id);
  assert.equal(whatsappRetry.status, "failed");
  assert.equal(whatsappRetry.attempts, 1);
  assert.ok(
    whatsappRetry.nextAttemptAt,
    "WhatsApp provenance failure has a retry time",
  );

  console.log("PASS: reviewed import/outbox PostgreSQL transaction race guard.");
} finally {
  try {
    // Delete dependent fixture rows before parents even if an assertion or
    // transaction setup failed midway through the suite.
    if (dealerId) {
      await pool.query(`delete from email_logs where dealer_id = $1`, [dealerId]);
    }
    if (leadId) await pool.query(`delete from leads where id = $1`, [leadId]);
    if (customerId) {
      await pool.query(`delete from customers where id = $1`, [customerId]);
    }
    if (dealerId) await pool.query(`delete from dealers where id = $1`, [dealerId]);
  } finally {
    await pool.end();
  }
}