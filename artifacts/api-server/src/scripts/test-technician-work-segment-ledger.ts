import assert from "node:assert/strict";
import type { Server } from "node:http";

export {};

function refuse(reason: string): never {
  console.error(`test-technician-work-segment-ledger refuses to run: ${reason}`);
  process.exit(1);
}

// This suite mutates a fixture database. Validate the database target before
// importing @workspace/db (ESM imports otherwise initialize a pool first).
if (process.env.NODE_ENV === "production") {
  refuse("NODE_ENV=production — this is a development-only fixture suite.");
}
const databaseUrl = process.env.DATABASE_URL ?? process.env.DEV_DATABASE_URL;
if (!databaseUrl) refuse("DATABASE_URL or DEV_DATABASE_URL is not set.");
let databaseHost: string;
try {
  databaseHost = new URL(databaseUrl).hostname.toLowerCase();
} catch {
  refuse("Development database URL is not parseable.");
}
if (!new Set(["helium", "localhost", "127.0.0.1"]).has(databaseHost)) {
  refuse("Database target is not an allowlisted development host.");
}
if (process.env.PROD_DATABASE_URL) {
  try {
    const production = new URL(process.env.PROD_DATABASE_URL);
    const candidate = new URL(databaseUrl);
    if (
      candidate.hostname === production.hostname &&
      candidate.pathname === production.pathname
    ) {
      refuse("Development database URL matches PROD_DATABASE_URL.");
    }
  } catch {
    // An unparseable optional production URL cannot weaken the host allowlist.
  }
}

const { pool } = await import("@workspace/db");

const marker = `technician-work-segment-${Date.now()}`;
let dealerId: number | undefined;
let firstTechnicianId: number | undefined;
let secondTechnicianId: number | undefined;
let historicalNonTechnicianRoleId: number | undefined;
let httpServer: Server | undefined;

async function one<T>(sql: string, values: unknown[] = []): Promise<T> {
  const result = await pool.query(sql, values);
  assert(result.rows[0], `Expected a row from: ${sql}`);
  return result.rows[0] as T;
}

async function jobCard(
  technicianUserId: number | null,
  title: string,
): Promise<number> {
  const order = await one<{ id: number }>(
    `insert into service_orders (dealer_id, vehicle_info, scheduled_date)
     values ($1, $2, '2026-10-01') returning id`,
    [dealerId, `${marker} vehicle ${title}`],
  );
  const card = await one<{ id: number }>(
    `insert into job_cards
       (dealer_id, service_order_id, title, status, technician_user_id, technician_name)
     values ($1, $2, $3, 'in_progress', $4,
       (select name from users where id = $4))
     returning id`,
    [dealerId, order.id, title, technicianUserId],
  );
  return card.id;
}

async function deleteLedgerForCard(jobCardId: number) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      "select set_config('app.technician_work_segment_ledger_maintenance', 'on', true)",
    );
    await client.query(
      "delete from technician_work_segment_ledger where dealer_id = $1 and job_card_id = $2",
      [dealerId, jobCardId],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function cleanup() {
  if (!dealerId) return;
  // The ledger is append-only in normal execution. Regression fixtures use
  // only the migration's transaction-local maintenance escape hatch.
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      "select set_config('app.technician_work_segment_ledger_maintenance', 'on', true)",
    );
    await client.query("delete from job_cards where dealer_id = $1", [dealerId]);
    await client.query(
      "delete from technician_work_segment_ledger where dealer_id = $1",
      [dealerId],
    );
    await client.query(
      "delete from technician_timesheet_entries where dealer_id = $1",
      [dealerId],
    );
    await client.query("delete from service_orders where dealer_id = $1", [dealerId]);
    await client.query(
      "delete from users where id = any($1::int[])",
      [[firstTechnicianId, secondTechnicianId].filter((id): id is number => id != null)],
    );
    if (historicalNonTechnicianRoleId != null) {
      await client.query("delete from roles where id = $1", [historicalNonTechnicianRoleId]);
    }
    await client.query("delete from dealers where id = $1", [dealerId]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

try {
  const dealer = await one<{ id: number }>(
    `insert into dealers (name, status, timezone, entitlements)
     values ($1, 'active', 'America/Guyana', '{}'::jsonb) returning id`,
    [`${marker} dealer`],
  );
  dealerId = dealer.id;
  const technicians = await pool.query<{ id: number; name: string }>(
    `insert into users (clerk_id, email, name, status)
     values ($1, $2, $3, 'active'), ($4, $5, $6, 'active')
     returning id, name`,
    [
      `${marker}-one`, `${marker}-one@example.invalid`, `${marker} One`,
      `${marker}-two`, `${marker}-two@example.invalid`, `${marker} Two`,
    ],
  );
  firstTechnicianId = technicians.rows[0]!.id;
  secondTechnicianId = technicians.rows[1]!.id;
  const technicianRole = await one<{ id: number }>(
    `insert into roles (name, description, is_system)
     values ('Technician', 'Fixture technician role', true)
     on conflict (name) do update set name = excluded.name
     returning id`,
  );
  const historicalNonTechnicianRole = await one<{ id: number }>(
    `insert into roles (name, description, is_system)
     values ($1, 'Fixture role used to remove Technician access', false)
     returning id`,
    [`${marker} historical non-technician`],
  );
  historicalNonTechnicianRoleId = historicalNonTechnicianRole.id;
  await pool.query(
    `insert into dealer_users (dealer_id, user_id, role_id)
     values ($1, $2, $4), ($1, $3, $4)`,
    [dealerId, firstTechnicianId, secondTechnicianId, technicianRole.id],
  );

  // A pre-ledger historical total must not be copied simply because an
  // unrelated card field changes.
  const legacyCardId = await jobCard(firstTechnicianId, "legacy");
  await pool.query(
    "update job_cards set timer_seconds = 5400, title = title || ' untouched' where id = $1",
    [legacyCardId],
  );
  const legacyEvents = await one<{ count: string }>(
    `select count(*)::text as count from technician_work_segment_ledger
      where dealer_id = $1 and job_card_id = $2`,
    [dealerId, legacyCardId],
  );
  assert.equal(legacyEvents.count, "0", "legacy timer total was backfilled");

  // Simulate a card that was already running before this migration: erase the
  // generated start boundary while retaining the active timer, then stop it.
  // Its historic elapsed time must never become an automatic actual.
  const legacyRunningCardId = await jobCard(secondTechnicianId, "legacy running");
  await pool.query(
    "update job_cards set timer_started_at = '2000-01-01T00:00:00.000Z' where id = $1",
    [legacyRunningCardId],
  );
  await deleteLedgerForCard(legacyRunningCardId);
  await pool.query(
    "update job_cards set timer_seconds = 7200, timer_started_at = null where id = $1",
    [legacyRunningCardId],
  );
  const legacyRunningStop = await one<{
    event_type: string;
    segment_started_at: Date | null;
    duration_seconds: number | null;
  }>(
    `select event_type, segment_started_at, duration_seconds
       from technician_work_segment_ledger
      where dealer_id = $1 and job_card_id = $2
      order by id desc limit 1`,
    [dealerId, legacyRunningCardId],
  );
  assert.equal(legacyRunningStop.event_type, "legacy_timer_stopped");
  assert.equal(legacyRunningStop.segment_started_at, null);
  assert.equal(legacyRunningStop.duration_seconds, null);

  const cardId = await jobCard(firstTechnicianId, "midnight and reassignment");
  // 03:30Z is 23:30 on the prior date in America/Guyana. The ledger keeps the
  // dealer timezone snapshot used by a later timesheet reader to split days.
  await pool.query(
    `update job_cards
       set timer_started_at = '2026-10-01T03:30:00.000Z'
     where id = $1`,
    [cardId],
  );
  const started = await one<{
    event_type: string;
    dealer_timezone_snapshot: string;
    local_day: string;
    technician_name_snapshot: string | null;
  }>(
    `select event_type, dealer_timezone_snapshot, technician_name_snapshot,
            to_char(segment_started_at at time zone dealer_timezone_snapshot, 'YYYY-MM-DD') as local_day
       from technician_work_segment_ledger
      where dealer_id = $1 and job_card_id = $2
      order by id desc limit 1`,
    [dealerId, cardId],
  );
  assert.equal(started.event_type, "start");
  assert.equal(started.dealer_timezone_snapshot, "America/Guyana");
  assert.equal(started.local_day, "2026-09-30", "midnight boundary lost dealer timezone");
  assert.equal(started.technician_name_snapshot, `${marker} One`);

  // The closing entry must preserve the identity/timezone at segment start,
  // not whatever a dealer or staff profile says when it is paused.
  await pool.query("update dealers set timezone = 'UTC' where id = $1", [dealerId]);
  await pool.query(
    "update users set name = $2 where id = $1",
    [firstTechnicianId, `${marker} One Renamed`],
  );
  await pool.query(
    "update job_cards set technician_name = $2 where id = $1",
    [cardId, `${marker} One Renamed`],
  );
  await pool.query(
    "update job_cards set timer_seconds = timer_seconds + 1, timer_started_at = null where id = $1",
    [cardId],
  );
  const paused = await one<{
    event_type: string;
    duration_seconds: number | null;
    dealer_timezone_snapshot: string;
    technician_name_snapshot: string | null;
  }>(
    `select event_type, duration_seconds, dealer_timezone_snapshot, technician_name_snapshot
       from technician_work_segment_ledger
      where dealer_id = $1 and job_card_id = $2 order by id desc limit 1`,
    [dealerId, cardId],
  );
  assert.equal(paused.event_type, "pause");
  assert((paused.duration_seconds ?? 0) >= 0, "pause did not close a segment");
  assert.equal(paused.dealer_timezone_snapshot, "America/Guyana");
  assert.equal(paused.technician_name_snapshot, `${marker} One`);

  await pool.query(
    "update job_cards set timer_started_at = now() where id = $1",
    [cardId],
  );
  await pool.query(
    "update job_cards set technician_user_id = $2, technician_name = $3 where id = $1",
    [cardId, secondTechnicianId, `${marker} Two`],
  );
  const reassigned = await one<{
    event_type: string;
    technician_user_id: number | null;
    next_technician_user_id: number | null;
    timer_started_at: Date | null;
  }>(
    `select l.event_type, l.technician_user_id, l.next_technician_user_id, c.timer_started_at
       from technician_work_segment_ledger l
       join job_cards c on c.id = l.job_card_id
      where l.dealer_id = $1 and l.job_card_id = $2
      order by l.id desc limit 1`,
    [dealerId, cardId],
  );
  assert.equal(reassigned.event_type, "reassigned");
  assert.equal(reassigned.technician_user_id, firstTechnicianId);
  assert.equal(reassigned.next_technician_user_id, secondTechnicianId);
  assert.equal(reassigned.timer_started_at, null, "reassignment transferred a running timer");

  await pool.query("update job_cards set status = 'completed' where id = $1", [cardId]);
  const completed = await one<{ event_type: string }>(
    `select event_type from technician_work_segment_ledger
      where dealer_id = $1 and job_card_id = $2 order by id desc limit 1`,
    [dealerId, cardId],
  );
  assert.equal(completed.event_type, "completed");

  // Same-card races use the route-equivalent compare-and-set predicates. They
  // may settle as pause or pause+resume, but must never double-close one
  // segment, reset an active start, or produce a duplicate completion.
  const sameCardRace = await jobCard(secondTechnicianId, "same-card races");
  await pool.query("update job_cards set timer_started_at = now() where id = $1", [sameCardRace]);
  const [pauseAttempt, resumeAttempt] = await Promise.all([
    pool.query(
      `update job_cards set timer_seconds = timer_seconds + 1, timer_started_at = null
        where id = $1 and status = 'in_progress' and timer_started_at is not null
        returning id`,
      [sameCardRace],
    ),
    pool.query(
      `update job_cards set timer_started_at = now()
        where id = $1 and status = 'in_progress' and timer_started_at is null
        returning id`,
      [sameCardRace],
    ),
  ]);
  assert.equal(pauseAttempt.rowCount, 1, "concurrent pause was not applied");
  assert([0, 1].includes(resumeAttempt.rowCount ?? 0), "invalid resume race result");
  const sameCardPauseCount = await one<{ count: string }>(
    `select count(*)::text as count from technician_work_segment_ledger
      where dealer_id = $1 and job_card_id = $2 and event_type = 'pause'`,
    [dealerId, sameCardRace],
  );
  assert.equal(sameCardPauseCount.count, "1", "concurrent pause double-closed a segment");
  const stateBeforeCompletion = await one<{ running: boolean }>(
    "select timer_started_at is not null as running from job_cards where id = $1",
    [sameCardRace],
  );
  if (!stateBeforeCompletion.running) {
    await pool.query("update job_cards set timer_started_at = now() where id = $1", [sameCardRace]);
  }
  const [completionPause, completionAttempt] = await Promise.all([
    pool.query(
      `update job_cards set timer_seconds = timer_seconds + 1, timer_started_at = null
        where id = $1 and status = 'in_progress' and timer_started_at is not null
        returning id`,
      [sameCardRace],
    ),
    pool.query(
      `update job_cards set status = 'completed', timer_seconds = timer_seconds + 1, timer_started_at = null
        where id = $1 and status = 'in_progress' and timer_started_at is not null
        returning id`,
      [sameCardRace],
    ),
  ]);
  assert.equal(
    (completionPause.rowCount ?? 0) + (completionAttempt.rowCount ?? 0),
    1,
    "concurrent pause/completion both changed the same running timer",
  );
  if ((completionPause.rowCount ?? 0) === 1) {
    await pool.query("update job_cards set status = 'completed' where id = $1", [sameCardRace]);
  }
  const sameCardCompletionCount = await one<{ count: string }>(
    `select count(*)::text as count from technician_work_segment_ledger
      where dealer_id = $1 and job_card_id = $2 and event_type = 'completed'`,
    [dealerId, sameCardRace],
  );
  assert.equal(sameCardCompletionCount.count, "1", "same-card completion was duplicated or dropped");

  // Separate pooled queries execute in separate transactions. The trigger's
  // advisory lock permits exactly one concurrent start for this technician.
  const concurrentA = await jobCard(firstTechnicianId, "concurrent A");
  const concurrentB = await jobCard(firstTechnicianId, "concurrent B");
  const starts = await Promise.allSettled([
    pool.query("update job_cards set timer_started_at = now() where id = $1", [concurrentA]),
    pool.query("update job_cards set timer_started_at = now() where id = $1", [concurrentB]),
  ]);
  assert.equal(starts.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = starts.find((result) => result.status === "rejected");
  assert(rejected && rejected.status === "rejected");
  assert.equal((rejected.reason as { code?: string }).code, "23505");

  // HTTP regression: reopening a completed card for a technician who has
  // another active timer must report the timer conflict, not the unrelated
  // active-vehicle message that the old broad 23505 catch returned.
  const reopenCard = await jobCard(secondTechnicianId, "HTTP reopen contention");
  await pool.query("update job_cards set status = 'completed' where id = $1", [reopenCard]);
  const blockingCard = await jobCard(secondTechnicianId, "HTTP timer blocker");
  await pool.query("update job_cards set timer_started_at = now() where id = $1", [blockingCard]);
  process.env.AUTH_BYPASS = "1";
  const { default: app } = await import("../app");
  httpServer = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    httpServer!.once("listening", resolve);
    httpServer!.once("error", reject);
  });
  const address = httpServer.address();
  assert(address && typeof address !== "string");
  const httpPort = address.port;
  const response = await fetch(
    `http://127.0.0.1:${address.port}/api/job-cards/${reopenCard}/reopen`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-dealer-id": String(dealerId),
      },
      body: JSON.stringify({}),
    },
  );
  const responseBody = await response.json() as { error?: string };
  assert.equal(response.status, 409);
  assert.match(
    responseBody.error ?? "",
    /technician already has a running job-card timer/i,
  );
  // Freeze every fixture timer before comparing repeated read-model responses.
  // The summary contains a dealer-wide cumulative legacy residual, so a live
  // timer would make an otherwise identical historical report time-dependent.
  await pool.query(
    "update job_cards set timer_started_at = null where id = any($1::int[]) and timer_started_at is not null",
    [[concurrentA, concurrentB, blockingCard]],
  );

  // Actual HTTP regression for the timesheet read model. Insert a closed
  // ledger interval plus a pre-existing manual same-job/day correction. The
  // API must return both rows, but the automatic one must be visibly excluded
  // from automatic/captured actuals rather than silently double counting it.
  const timesheetCard = await jobCard(firstTechnicianId, "timesheet HTTP");
  const timesheetOrder = await one<{ service_order_id: number }>(
    "select service_order_id from job_cards where id = $1",
    [timesheetCard],
  );
  const timesheetDate = await one<{ work_date: string }>(
    `select to_char(now() at time zone 'America/Guyana', 'YYYY-MM-DD') as work_date`,
  );
  await pool.query(
    `insert into technician_work_segment_ledger (
       dealer_id, job_card_id, technician_user_id, technician_name_snapshot,
       dealer_timezone_snapshot, event_type, segment_started_at,
       segment_ended_at, duration_seconds
     ) values (
       $1, $2, $3, $4, 'America/Guyana', 'pause',
       now() - interval '15 minutes', now(), 900
     )`,
    [dealerId, timesheetCard, firstTechnicianId, `${marker} One`],
  );
  await pool.query(
    `insert into technician_timesheet_entries (
       dealer_id, technician_user_id, work_date, job_card_id,
       duration_minutes, note, source
     ) values ($1, $2, $3::date, $4, 30, 'manual correction', 'manual')`,
    [dealerId, firstTechnicianId, timesheetDate.work_date, timesheetCard],
  );
  type TimesheetBody = {
    summary?: {
      manualActualHours?: number;
      automaticActualHours?: number;
      capturedActualHours?: number;
    };
    rows?: Array<{
      technicianUserId: number;
      entries: Array<{
        source: string;
        jobCardId: number | null;
        sourceMetadata?: { counted?: boolean; exclusionReason?: string | null } | null;
      }>;
    }>;
  };
  async function getTimesheet(technicianUserId = firstTechnicianId): Promise<TimesheetBody> {
    const technicianQuery =
      technicianUserId == null ? "" : `&technicianUserId=${technicianUserId}`;
    const response = await fetch(
      `http://127.0.0.1:${httpPort}/api/service-timesheets?date=${timesheetDate.work_date}${technicianQuery}`,
      {
        headers: {
          "x-dealer-id": String(dealerId),
        },
      },
    );
    assert.equal(response.status, 200, "timesheet GET returned an error");
    return response.json() as Promise<TimesheetBody>;
  }
  const timesheetBody = await getTimesheet();
  const firstTechTimesheet = timesheetBody.rows?.find(
    (row) => row.technicianUserId === firstTechnicianId,
  );
  assert(firstTechTimesheet, "timesheet omitted the fixture technician");
  const automaticEntry = firstTechTimesheet.entries.find(
    (entry) => entry.source === "automatic" && entry.jobCardId === timesheetCard,
  );
  assert(automaticEntry, "timesheet omitted captured automatic work");
  assert.equal(automaticEntry.sourceMetadata?.counted, false);
  assert.equal(
    automaticEntry.sourceMetadata?.exclusionReason,
    "manual_job_day_supersedes_automatic",
  );
  assert.equal(timesheetBody.summary?.automaticActualHours, 0);
  assert.equal(timesheetBody.summary?.manualActualHours, 0.5);
  assert.equal(timesheetBody.summary?.capturedActualHours, 0.5);

  // Delete through the supported service-order route. Its transaction must
  // preserve the manual entry's immutable original-card key before the FK
  // nulls the live relation, so retained ledger work remains superseded.
  const deletedOrder = await fetch(
    `http://127.0.0.1:${httpPort}/api/service-orders/${timesheetOrder.service_order_id}`,
    {
      method: "DELETE",
      headers: {
        "x-dealer-id": String(dealerId),
      },
    },
  );
  assert.equal(deletedOrder.status, 204, "service-order delete failed");
  const preservedManualAssociation = await one<{
    job_card_id: number | null;
    original_job_card_id: number | null;
  }>(
    `select job_card_id, original_job_card_id
       from technician_timesheet_entries
      where dealer_id = $1 and technician_user_id = $2
        and work_date = $3::date and note = 'manual correction'`,
    [dealerId, firstTechnicianId, timesheetDate.work_date],
  );
  assert.equal(preservedManualAssociation.job_card_id, null);
  assert.equal(
    preservedManualAssociation.original_job_card_id,
    timesheetCard,
    "service-order deletion did not preserve the manual entry's original card",
  );
  const afterOrderDelete = await getTimesheet();
  const deletedCardRow = afterOrderDelete.rows?.find(
    (row) => row.technicianUserId === firstTechnicianId,
  );
  assert(deletedCardRow, "timesheet omitted historical work after card deletion");
  const deletedAutomaticEntry = deletedCardRow.entries.find(
    (entry) => entry.source === "automatic" && entry.jobCardId === timesheetCard,
  );
  const deletedManualEntry = deletedCardRow.entries.find(
    (entry) => entry.source === "manual",
  );
  assert(deletedAutomaticEntry, "deleted card lost retained automatic work");
  assert(deletedManualEntry, "deleted card lost retained manual work");
  assert.equal(
    deletedAutomaticEntry.sourceMetadata?.counted,
    false,
    "service-order deletion lost manual/automatic supersession",
  );
  assert.equal(
    deletedAutomaticEntry.sourceMetadata?.exclusionReason,
    "manual_job_day_supersedes_automatic",
  );
  assert.equal(deletedManualEntry.jobCardId, null, "deleted live card link was not cleared");
  assert.equal(afterOrderDelete.summary?.automaticActualHours, 0);
  assert.equal(afterOrderDelete.summary?.manualActualHours, 0.5);
  assert.equal(afterOrderDelete.summary?.capturedActualHours, 0.5);

  // The database trigger is the final backstop for a direct card delete too:
  // this intentionally uses an old-compatible raw manual insert with no
  // original_job_card_id, then verifies FK nullification cannot lose the
  // supersession key outside the supported route.
  const directDeleteCard = await jobCard(firstTechnicianId, "timesheet direct delete");
  await pool.query(
    `insert into technician_work_segment_ledger (
       dealer_id, job_card_id, technician_user_id, technician_name_snapshot,
       dealer_timezone_snapshot, event_type, segment_started_at,
       segment_ended_at, duration_seconds
     ) values (
       $1, $2, $3, $4, 'America/Guyana', 'pause',
       now() - interval '15 minutes', now(), 900
     )`,
    [dealerId, directDeleteCard, firstTechnicianId, `${marker} One`],
  );
  await pool.query(
    `insert into technician_timesheet_entries (
       dealer_id, technician_user_id, work_date, job_card_id,
       duration_minutes, note, source
     ) values ($1, $2, $3::date, $4, 15, 'direct-delete correction', 'manual')`,
    [dealerId, firstTechnicianId, timesheetDate.work_date, directDeleteCard],
  );
  const beforeDirectCardDelete = await getTimesheet();
  assert.equal(beforeDirectCardDelete.summary?.automaticActualHours, 0);
  assert.equal(beforeDirectCardDelete.summary?.manualActualHours, 0.75);
  await pool.query("delete from job_cards where id = $1", [directDeleteCard]);
  const directDeletedManual = await one<{
    job_card_id: number | null;
    original_job_card_id: number | null;
  }>(
    `select job_card_id, original_job_card_id
       from technician_timesheet_entries
      where dealer_id = $1 and technician_user_id = $2
        and work_date = $3::date and note = 'direct-delete correction'`,
    [dealerId, firstTechnicianId, timesheetDate.work_date],
  );
  assert.equal(directDeletedManual.job_card_id, null);
  assert.equal(directDeletedManual.original_job_card_id, directDeleteCard);
  const afterDirectCardDelete = await getTimesheet();
  assert.equal(afterDirectCardDelete.summary?.automaticActualHours, 0);
  assert.equal(afterDirectCardDelete.summary?.manualActualHours, 0.75);
  assert.equal(afterDirectCardDelete.summary?.capturedActualHours, 0.75);

  // Historical work remains visible to a manager after the technician loses
  // the Technician role and even after their dealer membership is removed.
  // These GETs are manager-scoped; they do not relax self-scope or write
  // authorization checks.
  const historicalSummary = afterDirectCardDelete.summary;
  const historicalRow = afterDirectCardDelete.rows?.find(
    (row) => row.technicianUserId === firstTechnicianId,
  );
  assert(historicalRow, "timesheet omitted historical technician after direct deletion");
  await pool.query(
    "update dealer_users set role_id = $3 where dealer_id = $1 and user_id = $2",
    [dealerId, firstTechnicianId, historicalNonTechnicianRoleId],
  );
  const reRoledTimesheet = await getTimesheet();
  assert.deepEqual(reRoledTimesheet.summary, historicalSummary);
  assert.deepEqual(reRoledTimesheet.rows, [historicalRow]);
  await pool.query(
    "delete from dealer_users where dealer_id = $1 and user_id = $2",
    [dealerId, firstTechnicianId],
  );
  const removedMembershipTimesheet = await getTimesheet();
  assert.deepEqual(removedMembershipTimesheet.summary, historicalSummary);
  assert.deepEqual(removedMembershipTimesheet.rows, [historicalRow]);

  // With no current Technician memberships at all, historical dealer-day
  // rows and the dealer-wide legacy residual still form the manager report.
  const allHistoricalTimesheet = await getTimesheet(undefined);
  await pool.query(
    "delete from dealer_users where dealer_id = $1 and user_id = $2",
    [dealerId, secondTechnicianId],
  );
  const noCurrentTechniciansTimesheet = await getTimesheet(undefined);
  assert.deepEqual(noCurrentTechniciansTimesheet.summary, allHistoricalTimesheet.summary);
  assert.deepEqual(noCurrentTechniciansTimesheet.rows, allHistoricalTimesheet.rows);

  console.log("Technician work-segment ledger DB checks passed");
} finally {
  if (httpServer) {
    await new Promise<void>((resolve, reject) =>
      httpServer!.close((error) => error ? reject(error) : resolve()),
    );
  }
  await cleanup();
  await pool.end();
}