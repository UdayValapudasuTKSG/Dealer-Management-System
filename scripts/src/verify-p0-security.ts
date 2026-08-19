import { eq } from "drizzle-orm";
import {
  db,
  pool,
  vehiclesTable,
  impersonationGrantsTable,
} from "@workspace/db";

// Fail-closed verification for the P0 security fixes (run against the DEV
// api-server; uses the dev-only x-test-user-email persona header):
//   1. NC-1 tenant isolation — non-member x-dealer-id → 403; foreign row → 404
//   2. Storage ACL — cross-dealer prefixed key → 404; unreferenced legacy → 404
//   3. NC-13 kill switch — dealer GM cannot pause/resume agents (403)
//   4. NC-10 impersonation — grant required (403), reason required (400),
//      read-only blocks writes (403), elevated still hard-blocks money (403)

const BASE = process.env.API_BASE ?? "http://localhost:80/api";
const SHARED_FIXTURE_LOCK = "aura-security-validation-shared-fixtures-v1";
// Dedicated ephemeral GM identity: created at startup as a dealer-2 member
// with NO dealer-1 membership (the tenant-isolation tests depend on that),
// deleted again in the finally block. Never reuse a shared demo account here
// — its memberships can legitimately change (e.g. gm@aura-demo.com was later
// added to dealer 1) and silently invalidate the suite's premise.
const GM = "p0-test-gm@aura-test.local";
// SUPER_ADMIN_EMAIL may be a comma-separated list; the persona header needs a
// super admin that also EXISTS in the users table — resolved at runtime.
const SUPER_CANDIDATES = (
  process.env.SUPER_ADMIN_EMAIL ?? "uday.valapudasu@theksquaregroup.com"
)
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail: string) {
  if (condition) {
    passed++;
    console.log(`  \u2713 ${name}`);
  } else {
    failed++;
    failures.push(`${name}: ${detail}`);
    console.log(`  \u2717 ${name} — ${detail}`);
  }
}

async function call(
  method: string,
  path: string,
  user: string,
  dealerId: number | null,
  body?: unknown,
) {
  const headers: Record<string, string> = {
    "x-test-user-email": user,
    "content-type": "application/json",
  };
  if (dealerId != null) headers["x-dealer-id"] = String(dealerId);
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json };
}

async function clearGrants(userEmail: string) {
  await pool.query(
    `DELETE FROM impersonation_grants WHERE user_id = (SELECT id FROM users WHERE email = $1)`,
    [userEmail],
  );
}

async function runSuite() {
  // The impersonation tests need a super admin WITHOUT a real dealer_users
  // membership (a direct membership legitimately bypasses impersonation).
  const superRow = await pool
    .query(
      `SELECT email FROM users
       WHERE lower(email) = ANY($1)
         AND id NOT IN (SELECT user_id FROM dealer_users)
       LIMIT 1`,
      [SUPER_CANDIDATES],
    )
    .then((r) => r.rows[0]);
  let SUPER: string;
  let tempSuperEmail: string | null = null;
  if (superRow) {
    SUPER = superRow.email as string;
  } else {
    // No membership-free super admin exists in users: temporarily seed one
    // from the candidate list (deleted again in the finally block).
    const candidate = await pool
      .query(`SELECT email FROM (SELECT unnest($1::text[]) AS email) c WHERE email NOT IN (SELECT lower(email) FROM users) LIMIT 1`, [SUPER_CANDIDATES])
      .then((r) => r.rows[0]?.email as string | undefined);
    if (!candidate) {
      throw new Error(
        "No super-admin candidate without a dealer membership available for impersonation testing",
      );
    }
    await pool.query(
      `INSERT INTO users (clerk_id, email, name) VALUES ($1, $2, 'P0 Test Super Admin')`,
      [`p0-test-${Date.now()}`, candidate],
    );
    SUPER = candidate;
    tempSuperEmail = candidate;
  }

  // Ephemeral GM: a dealer-2 member with no other memberships.
  const gmRole = await pool
    .query(
      `SELECT du.role_id FROM dealer_users du
       JOIN roles r ON r.id = du.role_id
       WHERE du.dealer_id = 2
       ORDER BY (r.name ILIKE '%manager%') DESC
       LIMIT 1`,
    )
    .then((r) => r.rows[0]?.role_id as number | undefined);
  if (!gmRole) throw new Error("No dealer-2 role found to seed the test GM");
  await pool.query(`DELETE FROM users WHERE lower(email) = $1`, [GM]);
  const gmUserId = await pool
    .query(
      `INSERT INTO users (clerk_id, email, name, status)
       VALUES ($1, $2, 'P0 Test GM', 'active') RETURNING id`,
      [`p0-test-gm-${Date.now()}`, GM],
    )
    .then((r) => r.rows[0].id as number);
  await pool.query(
    `INSERT INTO dealer_users (dealer_id, user_id, role_id) VALUES (2, $1, $2)`,
    [gmUserId, gmRole],
  );

  // ---- fixtures --------------------------------------------------------
  const [foreignVehicle] = await db
    .insert(vehiclesTable)
    .values({
      dealerId: 1,
      vin: "P0SEC000000000001",
      make: "TestMake",
      model: "TestModel",
      year: 2026,
      price: 10000,
      powertrain: "gas",
      mileageKm: 0,
      exteriorColor: "Black",
      bodyType: "SUV",
      status: "in_stock",
    } as any)
    .returning({ id: vehiclesTable.id });
  const foreignVehicleId = foreignVehicle!.id;

  const [ownVehicleRow] = await pool.query(
    `SELECT id FROM vehicles WHERE dealer_id = 2 AND id <> $1 LIMIT 1`,
    [foreignVehicleId],
  ).then((r) => r.rows);
  const ownVehicleId = ownVehicleRow?.id as number;

  await clearGrants(SUPER);

  try {
    console.log("\n1. Tenant isolation (NC-1)");
    {
      const r = await call("GET", "/vehicles", GM, 1);
      check("non-member x-dealer-id → 403", r.status === 403, `got ${r.status}`);
      const r2 = await call("GET", `/vehicles/${foreignVehicleId}`, GM, 2);
      check("foreign row id → 404", r2.status === 404, `got ${r2.status}`);
      const r3 = await call("GET", "/audit-logs", GM, 1);
      check("audit-logs with foreign dealer header → 403", r3.status === 403, `got ${r3.status}`);
    }

    console.log("\n2. Storage ACL");
    {
      const r = await call(
        "GET",
        "/storage/objects/uploads/dealer-1/some-object",
        GM,
        2,
      );
      check("cross-dealer prefixed key → 404", r.status === 404, `got ${r.status}`);
      const r2 = await call("GET", "/storage/objects/legacy-unreferenced-key", GM, 2);
      check("unreferenced legacy key → 404 (fail closed)", r2.status === 404, `got ${r2.status}`);
    }

    console.log("\n3. Agent kill switch (NC-13)");
    {
      const r = await call("PATCH", "/agents/2", GM, 2, { status: "paused" });
      check(
        "dealer GM pausing agent → 403 kill_switch_platform_reserved",
        r.status === 403 && r.json?.code === "kill_switch_platform_reserved",
        `got ${r.status} ${JSON.stringify(r.json)}`,
      );
    }

    console.log("\n4. Impersonation (NC-10)");
    {
      const r = await call("GET", "/vehicles", SUPER, 2);
      check(
        "super admin without grant → 403 impersonation_required",
        r.status === 403 && r.json?.code === "impersonation_required",
        `got ${r.status} ${JSON.stringify(r.json)}`,
      );

      const noReason = await call("POST", "/platform/impersonation", SUPER, null, {
        dealerId: 2,
      });
      check("grant without reason → 400", noReason.status === 400, `got ${noReason.status}`);

      const grant = await call("POST", "/platform/impersonation", SUPER, null, {
        dealerId: 2,
        reason: "P0 security verification",
        mode: "read_only",
      });
      check(
        "read-only grant created (201, mode read_only, ≤60m)",
        grant.status === 201 &&
          grant.json?.mode === "read_only" &&
          new Date(grant.json?.expiresAt).getTime() - Date.now() <= 60 * 60 * 1000 + 5000,
        `got ${grant.status} ${JSON.stringify(grant.json)}`,
      );

      const read = await call("GET", "/vehicles", SUPER, 2);
      check("read under read-only grant → 200", read.status === 200, `got ${read.status}`);

      const write = await call("PATCH", `/vehicles/${ownVehicleId}`, SUPER, 2, {
        price: 12345,
      });
      check(
        "write under read-only grant → 403 impersonation_read_only",
        write.status === 403 && write.json?.code === "impersonation_read_only",
        `got ${write.status} ${JSON.stringify(write.json)}`,
      );

      await clearGrants(SUPER);
      const elevated = await call("POST", "/platform/impersonation", SUPER, null, {
        dealerId: 2,
        reason: "P0 security verification (elevated)",
        mode: "elevated",
      });
      check("elevated grant created", elevated.status === 201 && elevated.json?.mode === "elevated", `got ${elevated.status}`);

      const money = await call("POST", "/payments", SUPER, 2, {});
      check(
        "money-posting under elevated grant → 403 impersonation_blocked",
        money.status === 403 && money.json?.code === "impersonation_blocked",
        `got ${money.status} ${JSON.stringify(money.json)}`,
      );
    }

    console.log("\n5. Super admin with a REAL dealer membership");
    {
      // A genuine dealer_users row takes precedence over impersonation:
      // no grant needed, but the workspace permissions are the ROLE's, not
      // platform FULL_PERMISSIONS. Verify with the most limited seed role.
      await clearGrants(SUPER);
      const techRoleId = await pool
        .query(`SELECT id FROM roles WHERE name = 'Technician' LIMIT 1`)
        .then((r) => r.rows[0]?.id as number | undefined);
      const superUserId = await pool
        .query(`SELECT id FROM users WHERE lower(email) = lower($1)`, [SUPER])
        .then((r) => r.rows[0]?.id as number);
      await pool.query(
        `INSERT INTO dealer_users (dealer_id, user_id, role_id) VALUES (2, $1, $2)`,
        [superUserId, techRoleId ?? null],
      );
      try {
        const read = await call("GET", "/vehicles", SUPER, 2);
        check(
          "member super admin binds without impersonation grant",
          read.json?.code !== "impersonation_required",
          `got ${read.status} ${JSON.stringify(read.json)}`,
        );
        const me = await call("GET", "/auth/me", SUPER, 2);
        check(
          "member super admin gets ROLE identity, not Super Admin",
          me.status === 200 && me.json?.roleName === "Technician",
          `got ${me.status} roleName=${me.json?.roleName}`,
        );
        const write = await call("POST", "/vehicles", SUPER, 2, {
          make: "X",
          model: "Y",
          year: 2026,
          price: 1,
        });
        check(
          "member super admin is limited to role permissions → 403",
          write.status === 403,
          `got ${write.status} ${JSON.stringify(write.json)}`,
        );
      } finally {
        await pool.query(
          `DELETE FROM dealer_users WHERE dealer_id = 2 AND user_id = $1`,
          [superUserId],
        );
      }
    }
    console.log("\n6. Pipeline reconciliation (NC-14, tenant status, entitlement, NC-7)");
    {
      // NC-14: no dealer header + no membership → GET returns a 200 picker
      // payload; mutations get 400 dealer_required.
      await clearGrants(SUPER);
      const picker = await call("GET", "/vehicles", SUPER, null);
      check(
        "no active dealer GET → 200 dealer_selection_required",
        picker.status === 200 && picker.json?.code === "dealer_selection_required",
        `got ${picker.status} ${JSON.stringify(picker.json)}`,
      );
      const mut = await call("POST", "/vehicles", SUPER, null, { make: "X" });
      check(
        "no active dealer mutation → 400 dealer_required",
        mut.status === 400 && mut.json?.error === "dealer_required",
        `got ${mut.status} ${JSON.stringify(mut.json)}`,
      );

      // Tenant status: suspended dealer serves reads, blocks writes with 423.
      await pool.query(`UPDATE dealers SET status = 'suspended' WHERE id = 2`);
      try {
        const read = await call("GET", "/vehicles", GM, 2);
        check("suspended dealer read → 200", read.status === 200, `got ${read.status}`);
        const write = await call("PATCH", `/vehicles/${ownVehicleId}`, GM, 2, {
          price: 10001,
        });
        check(
          "suspended dealer write → 423 tenant_suspended",
          write.status === 423 && write.json?.error === "tenant_suspended",
          `got ${write.status} ${JSON.stringify(write.json)}`,
        );
      } finally {
        await pool.query(`UPDATE dealers SET status = 'active' WHERE id = 2`);
      }

      // Entitlement gate (INV-ENT-1): disabled module reads as 404.
      await pool.query(
        `UPDATE dealers SET entitlements = '{"finance_los": false}'::jsonb WHERE id = 2`,
      );
      try {
        const r = await call("GET", "/invoices", GM, 2);
        check("unentitled module → 404", r.status === 404, `got ${r.status}`);
      } finally {
        await pool.query(`UPDATE dealers SET entitlements = '{}'::jsonb WHERE id = 2`);
      }
      const entitled = await call("GET", "/invoices", GM, 2);
      check("entitled module → 200", entitled.status === 200, `got ${entitled.status}`);

      // NC-7 idempotency: replay returns the stored response; same key with a
      // different body → 422 key_reuse_mismatch.
      const dealRow = await pool
        .query(`SELECT id FROM deals WHERE dealer_id = 2 LIMIT 1`)
        .then((r) => r.rows[0]);
      if (dealRow) {
        const key = `p0-idem-${Date.now()}`;
        const idemCall = (body: unknown) =>
          fetch(`${BASE}/deals/${dealRow.id}`, {
            method: "PATCH",
            headers: {
              "x-test-user-email": GM,
              "x-dealer-id": "2",
              "content-type": "application/json",
              "x-idempotency-key": key,
            },
            body: JSON.stringify(body),
          });
        const first = await idemCall({ discount: 1 });
        check("idempotent first call succeeds", first.ok, `got ${first.status}`);
        const replay = await idemCall({ discount: 1 });
        check(
          "same key + body → replay (Idempotent-Replay header)",
          replay.status === first.status &&
            replay.headers.get("idempotent-replay") === "true",
          `got ${replay.status} replay=${replay.headers.get("idempotent-replay")}`,
        );
        const mismatch = await idemCall({ discount: 2 });
        const mmJson: any = await mismatch.json().catch(() => null);
        check(
          "same key + different body → 422 key_reuse_mismatch",
          mismatch.status === 422 && mmJson?.error === "key_reuse_mismatch",
          `got ${mismatch.status} ${JSON.stringify(mmJson)}`,
        );
        await pool.query(`DELETE FROM idempotency_keys WHERE key = $1`, [key]);
      } else {
        check("idempotency tests need a dealer-2 deal", false, "no deal found");
      }
    }

    console.log("\n7. Rate limiting (429) — runs LAST (floods GM's bucket)");
    {
      // authedRateLimit is 600/min per user; flood cheap reads until a 429.
      let got429 = false;
      let reset: string | null = null;
      outer: for (let batch = 0; batch < 14; batch++) {
        const results = await Promise.all(
          Array.from({ length: 50 }, () =>
            fetch(`${BASE}/auth/me`, {
              headers: {
                "x-test-user-email": GM,
                "x-dealer-id": "2",
                "x-rate-limit-probe": "1",
              },
            }),
          ),
        );
        for (const r of results) {
          if (r.status === 429) {
            got429 = true;
            reset = r.headers.get("ratelimit-reset");
            break outer;
          }
        }
      }
      check(
        "flood → 429 with RateLimit-Reset header",
        got429 && reset != null,
        `got429=${got429} reset=${reset}`,
      );
    }
  } finally {
    await db.delete(vehiclesTable).where(eq(vehiclesTable.id, foreignVehicleId));
    await clearGrants(SUPER);
    if (tempSuperEmail) {
      await pool.query(`DELETE FROM users WHERE lower(email) = $1`, [
        tempSuperEmail,
      ]);
    }
    await pool.query(`DELETE FROM users WHERE lower(email) = $1`, [GM]);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(failures.map((f) => `  - ${f}`).join("\n"));
    process.exitCode = 1;
  }
}

async function main() {
  // Completion validation runs suites concurrently. This suite temporarily
  // suspends dealer 2 and toggles global agent policy while isolation-p5 uses
  // the same fixtures, so serialize those shared-fixture suites.
  const lockClient = await pool.connect();
  await lockClient.query("SELECT pg_advisory_lock(hashtext($1))", [
    SHARED_FIXTURE_LOCK,
  ]);
  try {
    await runSuite();
  } finally {
    await lockClient.query("SELECT pg_advisory_unlock(hashtext($1))", [
      SHARED_FIXTURE_LOCK,
    ]);
    lockClient.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
