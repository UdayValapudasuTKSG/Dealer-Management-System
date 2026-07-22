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
const GM = "gm@aura-demo.com"; // dealer 2 member
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

async function main() {
  const superRow = await pool
    .query(`SELECT email FROM users WHERE lower(email) = ANY($1) LIMIT 1`, [
      SUPER_CANDIDATES,
    ])
    .then((r) => r.rows[0]);
  if (!superRow) {
    throw new Error("No seeded super-admin user found for persona testing");
  }
  const SUPER = superRow.email as string;

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
  } finally {
    await db.delete(vehiclesTable).where(eq(vehiclesTable.id, foreignVehicleId));
    await clearGrants(SUPER);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(failures.map((f) => `  - ${f}`).join("\n"));
    process.exitCode = 1;
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
