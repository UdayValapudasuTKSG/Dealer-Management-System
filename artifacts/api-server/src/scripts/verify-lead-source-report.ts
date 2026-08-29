/**
 * verify-lead-source-report — regression suite for the daily lead-source
 * report sweep (Task 271/272).
 *
 * Confirms sweepLeadSourceReports with a seeded test dealer + GM:
 *   1. Concurrent partial service-settings updates (toggle + send time in
 *      parallel) keep BOTH values — column-scoped upsert, no clobbering.
 *   2. Before the configured dealer-local send time: no email is queued.
 *   3. At/after the send time: exactly one email per GM is queued.
 *   4. A repeat sweep run stays deduped (still exactly one).
 *   5. A mid-day send-time change does not cause a double send that day.
 *   6. Two overlapping sweep runs from a clean state queue exactly one.
 *   7. Disabling the report stops further queueing (and never un-queues).
 *
 * Direct-function suite: seeds its own ephemeral dealer/role/user fixtures
 * and cleans them up; no HTTP server required. Fails closed outside a
 * development database, and the sweep under test is scoped to the fixture
 * dealers only, so it can never enqueue reports for real dealers.
 */
// ---------------------------------------------------------------------------
// Fail-closed dev-database guard. Runs BEFORE any module that opens a DB
// connection is imported (all app imports below are dynamic, after this
// block). The database target is ALLOWLISTED: only the Replit workspace dev
// database (host "helium", also exposed as PGHOST) or an explicit
// localhost/127.0.0.1 database may be used. Anything else — production,
// staging, remote Neon endpoints, aliases, or a missing/unparseable URL —
// is rejected.
// ---------------------------------------------------------------------------
export {}; // module scope: enables top-level await for the post-guard dynamic imports

function refuse(reason: string): never {
  console.error(`verify-lead-source-report refuses to run: ${reason}`);
  process.exit(1);
}
if (process.env.NODE_ENV === "production") {
  refuse("NODE_ENV=production — this is a dev-only fixture suite.");
}
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
// Suppress the global outbox worker in this process: enqueueEmail kicks
// processQueue(), which would otherwise scan (and try to send) ready email
// rows for ALL dealers in the shared dev database, not just our fixtures.
process.env.OUTBOX_WORKER_DISABLED = "1";
{
  const raw = process.env.DATABASE_URL;
  if (!raw) refuse("DATABASE_URL is not set.");
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    refuse("DATABASE_URL is not a parseable URL.");
  }
  const allowedHosts = new Set(["helium", "localhost", "127.0.0.1"]);
  if (process.env.PGHOST) allowedHosts.add(process.env.PGHOST.toLowerCase());
  // PGHOST itself must not be a remote endpoint smuggled into the allowlist.
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
  // Belt and braces: never proceed if the URL matches the production DB.
  if (process.env.PROD_DATABASE_URL) {
    try {
      const prod = new URL(process.env.PROD_DATABASE_URL);
      const dev = new URL(raw);
      if (prod.hostname === dev.hostname && prod.pathname === dev.pathname) {
        refuse("DATABASE_URL matches PROD_DATABASE_URL.");
      }
    } catch {
      /* unparseable prod URL — host allowlist above already protects us */
    }
  }
}

// App modules are imported only after the guard has passed, so no DB pool
// ever initializes against a disallowed target.
const { pool } = await import("@workspace/db");
const { sweepLeadSourceReports } = await import("../lib/notification-sweeps");
const { getServiceSettings, updateServiceSettings } = await import(
  "../lib/service-settings"
);
const { zonedParts } = await import("../lib/timezone");

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    passed++;
    console.log(`  \u2713 ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? `: ${detail}` : ""}`);
    console.log(`  \u2717 ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * Pick an IANA zone whose current local hour is safely mid-day (01–21) so the
 * suite can express both a "before" and an "after" send time without the
 * dealer-local day rolling over while it runs (which would change the dedupe
 * key and fake a double send).
 */
const TZ_CANDIDATES = [
  "America/Guyana",
  "Asia/Tokyo",
  "Europe/London",
  "Pacific/Auckland",
  "America/Los_Angeles",
  "Asia/Kolkata",
  "Australia/Sydney",
  "Atlantic/Azores",
];
function pickTimezone(): string {
  const now = new Date();
  for (const tz of TZ_CANDIDATES) {
    const { hour } = zonedParts(now, tz);
    if (hour >= 1 && hour <= 21) return tz;
  }
  return "America/Guyana"; // unreachable — candidates span the globe
}

/** "HH:MM" dealer-local, offset by the given minutes from now (clamped to today). */
function localTimePlus(tz: string, deltaMinutes: number): string {
  const { hour, minute } = zonedParts(new Date(), tz);
  const total = Math.min(Math.max(hour * 60 + minute + deltaMinutes, 0), 23 * 60 + 59);
  const hh = String(Math.floor(total / 60)).padStart(2, "0");
  const mm = String(total % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

async function countReportEmails(dealerId: number): Promise<number> {
  const r = await pool.query(
    `SELECT count(*)::int AS n FROM email_logs
      WHERE dedupe_key LIKE $1`,
    [`leads:srcreport:${dealerId}:%`],
  );
  return r.rows[0].n as number;
}

type Fixture = { dealerId: number; userId: number };
let roleId: number | null = null;
const dealerIds: number[] = [];
const userIds: number[] = [];
const RUN = `lsr-${Date.now()}`;

async function seedDealerWithGm(tz: string, tag: string): Promise<Fixture> {
  const dealerId = (
    await pool.query(
      `INSERT INTO dealers (name, timezone, status) VALUES ($1, $2, 'active') RETURNING id`,
      [`Verify LeadSrcReport ${RUN}-${tag}`, tz],
    )
  ).rows[0].id as number;
  dealerIds.push(dealerId);
  const userId = (
    await pool.query(
      `INSERT INTO users (clerk_id, email, name, status)
       VALUES ($1, $2, 'LSR Test GM', 'active') RETURNING id`,
      [`${RUN}-${tag}`, `${RUN}-${tag}@aura-test.local`],
    )
  ).rows[0].id as number;
  userIds.push(userId);
  await pool.query(
    `INSERT INTO dealer_users (dealer_id, user_id, role_id, is_general_manager)
     VALUES ($1, $2, $3, true)`,
    [dealerId, userId, roleId],
  );
  return { dealerId, userId };
}

async function cleanup() {
  if (dealerIds.length > 0) {
    await pool.query(
      `DELETE FROM email_logs WHERE dealer_id = ANY($1::int[])`,
      [dealerIds],
    );
    await pool.query(
      `DELETE FROM dealer_service_settings WHERE dealer_id = ANY($1::int[])`,
      [dealerIds],
    );
    await pool.query(`DELETE FROM dealers WHERE id = ANY($1::int[])`, [
      dealerIds,
    ]);
  }
  if (userIds.length > 0)
    await pool.query(`DELETE FROM users WHERE id = ANY($1::int[])`, [userIds]);
  if (roleId != null)
    await pool.query(`DELETE FROM roles WHERE id = $1`, [roleId]);
}

async function main() {
  const tz = pickTimezone();
  console.log(`Lead-source report regression suite (test tz: ${tz})`);

  roleId = (
    await pool.query(
      `INSERT INTO roles (name, description) VALUES ($1, 'ephemeral verify fixture') RETURNING id`,
      [`Verify LSR Role ${RUN}`],
    )
  ).rows[0].id as number;

  const a = await seedDealerWithGm(tz, "a");

  // --- 1. Concurrent partial updates keep both values ----------------------
  console.log("\n1. Concurrent partial service-settings updates");
  await Promise.all([
    updateServiceSettings(a.dealerId, { leadSourceReportEnabled: true }),
    updateServiceSettings(a.dealerId, { leadSourceReportSendTime: "07:15" }),
  ]);
  let s = await getServiceSettings(a.dealerId);
  check(
    "toggle survives concurrent send-time update",
    s.leadSourceReportEnabled === true,
    `enabled=${s.leadSourceReportEnabled}`,
  );
  check(
    "send time survives concurrent toggle update",
    s.leadSourceReportSendTime === "07:15",
    `sendTime=${s.leadSourceReportSendTime}`,
  );
  // Also both-at-once in one call alongside an unrelated concurrent column.
  await Promise.all([
    updateServiceSettings(a.dealerId, {
      leadSourceReportEnabled: true,
      leadSourceReportSendTime: "07:45",
    }),
    updateServiceSettings(a.dealerId, { serviceIntervalKm: 7777 }),
  ]);
  s = await getServiceSettings(a.dealerId);
  check(
    "combined toggle+time patch kept both",
    s.leadSourceReportEnabled === true && s.leadSourceReportSendTime === "07:45",
    `enabled=${s.leadSourceReportEnabled} sendTime=${s.leadSourceReportSendTime}`,
  );
  check(
    "unrelated concurrent column kept",
    s.serviceIntervalKm === 7777,
    `serviceIntervalKm=${s.serviceIntervalKm}`,
  );

  // --- 2. Before the configured send time: no-op ---------------------------
  console.log("\n2. Sweep before the configured dealer-local send time");
  await updateServiceSettings(a.dealerId, {
    leadSourceReportSendTime: localTimePlus(tz, 60),
  });
  await sweepLeadSourceReports(dealerIds);
  check(
    "no report queued before send time",
    (await countReportEmails(a.dealerId)) === 0,
    `count=${await countReportEmails(a.dealerId)}`,
  );

  // --- 3. At/after the send time: exactly one per GM -----------------------
  console.log("\n3. Sweep at/after the send time");
  await updateServiceSettings(a.dealerId, {
    leadSourceReportSendTime: localTimePlus(tz, -30),
  });
  await sweepLeadSourceReports(dealerIds);
  check(
    "exactly one report queued after send time",
    (await countReportEmails(a.dealerId)) === 1,
    `count=${await countReportEmails(a.dealerId)}`,
  );

  // --- 4. Repeat run stays deduped ------------------------------------------
  console.log("\n4. Repeat sweep run");
  await sweepLeadSourceReports(dealerIds);
  check(
    "repeat run does not double-send",
    (await countReportEmails(a.dealerId)) === 1,
    `count=${await countReportEmails(a.dealerId)}`,
  );

  // --- 5. Mid-day send-time change does not double-send ---------------------
  console.log("\n5. Mid-day send-time change");
  await updateServiceSettings(a.dealerId, {
    leadSourceReportSendTime: "00:05",
  });
  await sweepLeadSourceReports(dealerIds);
  check(
    "changing the send time mid-day does not double-send",
    (await countReportEmails(a.dealerId)) === 1,
    `count=${await countReportEmails(a.dealerId)}`,
  );

  // --- 6. Overlapping sweep runs from a clean state -------------------------
  console.log("\n6. Two overlapping sweep runs (fresh dealer)");
  const b = await seedDealerWithGm(tz, "b");
  await updateServiceSettings(b.dealerId, {
    leadSourceReportEnabled: true,
    leadSourceReportSendTime: "00:00",
  });
  await Promise.all([sweepLeadSourceReports(dealerIds), sweepLeadSourceReports(dealerIds)]);
  check(
    "concurrent sweeps queue exactly one report",
    (await countReportEmails(b.dealerId)) === 1,
    `count=${await countReportEmails(b.dealerId)}`,
  );

  // --- 7. Disabled dealers are skipped ---------------------------------------
  console.log("\n7. Disable toggle");
  const c = await seedDealerWithGm(tz, "c");
  await updateServiceSettings(c.dealerId, {
    leadSourceReportEnabled: false,
    leadSourceReportSendTime: "00:00",
  });
  await sweepLeadSourceReports(dealerIds);
  check(
    "disabled dealer never queues a report",
    (await countReportEmails(c.dealerId)) === 0,
    `count=${await countReportEmails(c.dealerId)}`,
  );
}

main()
  .catch((err) => {
    failed++;
    failures.push(`suite crashed: ${err instanceof Error ? err.message : String(err)}`);
    console.error(err);
  })
  .finally(async () => {
    try {
      await cleanup();
    } catch (err) {
      console.error("cleanup failed", err);
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failures.length > 0) {
      console.log("Failures:");
      for (const f of failures) console.log(`  - ${f}`);
    }
    await pool.end().catch(() => {});
    process.exit(failed > 0 ? 1 : 0);
  });
