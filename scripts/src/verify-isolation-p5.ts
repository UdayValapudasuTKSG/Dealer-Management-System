/**
 * P5 isolation + P3 lifecycle negative-test suite.
 * Covers N1, N2, N3, N10, N11, N13, N14, N16, N18, N20 from the P5 spec plus
 * dealer lifecycle (suspend/resume/offboard/close) and agent-policy checks.
 *
 * Requires the api-server workflow running; uses dev-only x-test-user-email.
 * Run: pnpm --filter @workspace/scripts run verify-isolation-p5
 */
import { pool } from "@workspace/db";

const BASE = "http://localhost:80/api";
const SUPER = "uday.valapudasu@theksquaregroup.com";
const SHARED_FIXTURE_LOCK = "aura-security-validation-shared-fixtures-v1";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function req(
  method: string,
  path: string,
  opts: { user?: string; dealerId?: number; body?: unknown } = {},
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (opts.user) headers["x-test-user-email"] = opts.user;
  if (opts.dealerId !== undefined) headers["x-dealer-id"] = String(opts.dealerId);
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json };
}

async function runSuite() {
  // Pick a dealer-1 member (non-super-admin) and dealer-2 foreign rows.
  // Ephemeral dealer-A identity: a General Manager who is a member of
  // dealer 2 ONLY. Never reuse a shared demo account — its memberships can
  // legitimately change over time (gm@aura-demo.com was later added to
  // dealer 1) and silently break the non-member 403 premise.
  const userA = "iso-test-gm@aura-test.local";
  const gmRoleId = await pool
    .query(`select id from roles where name = 'General Manager' limit 1`)
    .then((r) => r.rows[0]?.id as number | undefined);
  if (!gmRoleId) throw new Error("General Manager role not found");
  await pool.query(`delete from users where lower(email) = $1`, [userA]);
  const userAId = await pool
    .query(
      `insert into users (clerk_id, email, name, status)
       values ($1, $2, 'Iso Test GM', 'active') returning id`,
      [`iso-test-gm-${Date.now()}`, userA],
    )
    .then((r) => r.rows[0].id as number);
  await pool.query(
    `insert into dealer_users (dealer_id, user_id, role_id) values (2, $1, $2)`,
    [userAId, gmRoleId],
  );
  console.log(`Dealer-A user: ${userA} (ephemeral)`);

  try {
    await run(userA);
  } finally {
    await pool.query(`delete from users where lower(email) = $1`, [userA]);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log("Failures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exitCode = fail > 0 ? 1 : 0;
}

async function run(userA: string) {
  // Dealer 1 has no seed data — create scratch foreign rows so the 404
  // isolation checks exercise REAL cross-tenant ids, cleaned up at the end.
  const q = async (sqlText: string, params: unknown[] = []) =>
    (await pool.query(sqlText, params)).rows[0]?.id as number;
  const bCustomer = await q(
    `insert into customers (dealer_id, name) values (1, 'IsoForeign Zebraphant') returning id`,
  );
  const bLead = await q(
    `insert into leads (dealer_id, name) values (1, 'IsoForeign Lead') returning id`,
  );
  const bVehicle = await q(
    `insert into vehicles (dealer_id, make, model, year, price, powertrain, mileage_km, exterior_color, body_type)
     values (1, 'Iso', 'Foreign', 2026, 1, 'ICE', 0, 'Grey', 'SUV') returning id`,
  );
  const bDeal = await q(
    `insert into deals (dealer_id, vehicle_id, vehicle_price) values (1, $1, 1) returning id`,
    [bVehicle],
  );
  const bFinApp = await q(
    `insert into finance_applications (dealer_id, customer_name, amount, term_months, apr)
     values (1, 'IsoForeign Zebraphant', 1, 12, 5) returning id`,
  );
  const bServiceOrder = await q(
    `insert into service_orders (dealer_id, vehicle_info, scheduled_date)
     values (1, 'Iso Foreign SUV', '2026-07-30') returning id`,
  );
  const cleanupForeign = async () => {
    await pool.query(`delete from service_orders where id = $1`, [bServiceOrder]);
    await pool.query(`delete from finance_applications where id = $1`, [bFinApp]);
    await pool.query(`delete from deals where id = $1`, [bDeal]);
    await pool.query(`delete from vehicles where id = $1`, [bVehicle]);
    await pool.query(`delete from leads where id = $1`, [bLead]);
    await pool.query(`delete from customers where id = $1`, [bCustomer]);
  };

  console.log("\n== Tenant isolation (N-tests) ==");

  // N1: member of A sends x-dealer-id: B → 403
  {
    const r = await req("GET", "/leads", { user: userA, dealerId: 1 });
    check("N1 non-member x-dealer-id → 403", r.status === 403, `got ${r.status}`);
  }

  // N2: A user reads B customer by id → 404
  if (bCustomer) {
    const r = await req("GET", `/customers/${bCustomer}`, { user: userA, dealerId: 2 });
    check("N2 foreign customer id → 404", r.status === 404, `got ${r.status}`);
  }

  // N3: A user reads B lead + tries advance → 404 both
  if (bLead) {
    const r1 = await req("GET", `/leads/${bLead}`, { user: userA, dealerId: 2 });
    const r2 = await req("POST", `/leads/${bLead}/advance`, {
      user: userA,
      dealerId: 2,
      body: { toStage: "qualified" },
    });
    check(
      "N3 foreign lead read+advance → 404",
      r1.status === 404 && r2.status === 404,
      `got ${r1.status}/${r2.status}`,
    );
  }

  // N10: ordinary dealer user flips an agent kill switch → 403 (platform reserved)
  {
    const { rows } = await pool.query(
      "select id from agents where dealer_id = 2 order by id limit 1",
    );
    const agentId = rows[0]?.id;
    if (agentId) {
      const r = await req("PATCH", `/agents/${agentId}`, {
        user: userA,
        dealerId: 2,
        body: { status: "paused" },
      });
      check("N10 dealer user agent toggle → 403", r.status === 403, `got ${r.status}`);
    }
  }

  // N11: dealer user calls /platform/* → 403
  {
    const r = await req("GET", "/platform/dealers", { user: userA, dealerId: 2 });
    check("N11 dealer user /platform → 403", r.status === 403, `got ${r.status}`);
  }

  // N13: division filter cannot reach a B row
  if (bLead) {
    const r = await req("GET", `/leads/${bLead}?divisionId=1`, { user: userA, dealerId: 2 });
    check("N13 division filter still 404 on foreign row", r.status === 404, `got ${r.status}`);
  }

  // N14: omitted x-dealer-id on a data-plane mutation → 400 dealer_required
  {
    const r = await req("POST", "/leads", {
      user: userA,
      body: { name: "Iso Test", phone: "5926001234", source: "walk_in" },
    });
    check(
      "N14 mutation without x-dealer-id → 400",
      r.status === 400,
      `got ${r.status}`,
    );
  }

  // N16: dashboard aggregates contain no foreign rows
  {
    const r = await req("GET", "/dashboard/summary", { user: userA, dealerId: 2 });
    const blob = JSON.stringify(r.json ?? {});
    const leaked = blob.includes("Zebraphant");
    check(
      "N16 dashboard has no dealer-B names",
      r.status === 200 && !leaked,
      `status ${r.status}, leaked=${leaked}`,
    );
  }

  // N18: uniform 404 on foreign vehicles/deals/finance-applications/service-orders
  {
    const targets: Array<[string, number | undefined]> = [
      ["/vehicles", bVehicle],
      ["/deals", bDeal],
      ["/finance/applications", bFinApp],
      ["/service-orders", bServiceOrder],
    ];
    for (const [p, id] of targets) {
      if (!id) continue;
      const r = await req("GET", `${p}/${id}`, { user: userA, dealerId: 2 });
      check(`N18 foreign ${p} → 404`, r.status === 404, `got ${r.status}`);
    }
  }

  // N20: super admin without membership/grant cannot mutate data plane
  {
    // Other verification suites (p0-security) create 60-minute impersonation
    // grants for the same super-admin fixture; expire them so this test
    // really runs grant-less.
    await pool.query(
      `update impersonation_grants set expires_at = now()
       where expires_at > now()
         and user_id = (select id from users where email = $1)`,
      [SUPER],
    );
    const r = await req("POST", "/leads", {
      user: SUPER,
      dealerId: 1,
      body: {
        name: "Iso Test",
        phone: "5926001235",
        source: "walk_in",
        channel: "walkin",
      },
    });
    check("N20 super admin data-plane write → 403", r.status === 403, `got ${r.status}`);
  }

  await cleanupForeign();

  console.log("\n== Dealer lifecycle (P3) ==");

  // Create a scratch dealer directly (skip provisioning) for lifecycle checks.
  const { rows: dealerRows } = await pool.query(
    `insert into dealers (name, status) values ('Lifecycle Test Co', 'active') returning id`,
  );
  const dealerId = dealerRows[0].id as number;

  try {
    // Illegal transition: active → closed directly
    {
      const r = await req("POST", `/platform/dealers/${dealerId}/close`, { user: SUPER });
      check("L1 active→closed → 409 invalid_transition", r.status === 409, `got ${r.status}`);
    }
    // Suspend with blockers → 409, then force
    await pool.query(
      `insert into invoices (dealer_id, invoice_number, customer_name, amount, status)
       values ($1, 'LC-TEST-1', 'Blocker Test', 100, 'issued')`,
      [dealerId],
    );
    {
      const r = await req("POST", `/platform/dealers/${dealerId}/suspend`, {
        user: SUPER,
        body: { reason: "lifecycle test" },
      });
      check(
        "L2 suspend with open invoice → 409 blockers",
        r.status === 409 && Array.isArray(r.json?.blockers) && r.json.blockers.includes("open_invoices"),
        `got ${r.status} ${JSON.stringify(r.json)}`,
      );
    }
    {
      const r = await req("POST", `/platform/dealers/${dealerId}/suspend`, {
        user: SUPER,
        body: { reason: "lifecycle test", force: true },
      });
      check("L3 forced suspend → 200 suspended", r.status === 200 && r.json?.status === "suspended", `got ${r.status}`);
    }
    // Resume
    {
      const r = await req("POST", `/platform/dealers/${dealerId}/resume`, { user: SUPER });
      check("L4 resume → 200 active", r.status === 200 && r.json?.status === "active", `got ${r.status}`);
    }
    // Offboard → 202, saga completes
    {
      const r = await req("POST", `/platform/dealers/${dealerId}/offboard`, {
        user: SUPER,
        body: { reason: "lifecycle test offboard" },
      });
      check("L5 offboard → 202 offboarding", r.status === 202 && r.json?.status === "offboarding", `got ${r.status}`);
    }
    await new Promise((r) => setTimeout(r, 5000));
    {
      const { rows } = await pool.query(
        `select export_url, retention_until from dealers where id = $1`,
        [dealerId],
      );
      check(
        "L6 export saga delivered bundle + retention clock",
        !!rows[0]?.export_url && !!rows[0]?.retention_until,
        JSON.stringify(rows[0]),
      );
    }
    // Close blocked by retention
    {
      const r = await req("POST", `/platform/dealers/${dealerId}/offboarding/retry`, {
        user: SUPER,
      });
      check("L6b offboarding retry → 202", r.status === 202, `got ${r.status}`);
    }
    {
      const r = await req("POST", `/platform/dealers/${dealerId}/close`, { user: SUPER });
      check(
        "L7 close during retention → 422 retention_active",
        r.status === 422 && r.json?.unmet?.includes("retention_active"),
        `got ${r.status} ${JSON.stringify(r.json)}`,
      );
    }
    // Legal hold blocks close even after retention lapses
    await pool.query(
      `update dealers set retention_until = now() - interval '1 day', legal_hold = true where id = $1`,
      [dealerId],
    );
    {
      const r = await req("POST", `/platform/dealers/${dealerId}/close`, { user: SUPER });
      check(
        "L8 close with legal hold → 422 legal_hold",
        r.status === 422 && r.json?.unmet?.includes("legal_hold"),
        `got ${r.status} ${JSON.stringify(r.json)}`,
      );
    }
    await pool.query(`update dealers set legal_hold = false where id = $1`, [dealerId]);
    {
      const r = await req("POST", `/platform/dealers/${dealerId}/close`, { user: SUPER });
      check("L9 close → 200 closed", r.status === 200 && r.json?.status === "closed", `got ${r.status}`);
    }
    {
      const r = await req("POST", `/platform/dealers/${dealerId}/offboarding/retry`, {
        user: SUPER,
      });
      check("L9b retry on closed dealer → 409", r.status === 409, `got ${r.status}`);
    }
    {
      const r = await req("POST", `/platform/dealers/${dealerId}/resume`, { user: SUPER });
      check("L10 closed is terminal → 409", r.status === 409, `got ${r.status}`);
    }
  } finally {
    await pool.query(`delete from provisioning_steps where dealer_id = $1`, [dealerId]);
    await pool.query(`delete from invoices where dealer_id = $1`, [dealerId]);
    await pool.query(`delete from dealers where id = $1`, [dealerId]);
  }

  console.log("\n== Agent policies (P4) ==");
  {
    const r = await req("PATCH", "/platform/agent-policies", {
      user: SUPER,
      body: { agentKey: "not_a_real_agent", enabled: false },
    });
    check("P1 unknown agent key → 422", r.status === 422, `got ${r.status}`);
  }
  {
    const off = await req("PATCH", "/platform/agent-policies", {
      user: SUPER,
      body: { agentKey: "__all__", enabled: false, note: "verify suite" },
    });
    const list = await req("GET", "/platform/agent-policies", { user: SUPER });
    const row = (list.json ?? []).find((p: any) => p.agentKey === "__all__");
    const on = await req("PATCH", "/platform/agent-policies", {
      user: SUPER,
      body: { agentKey: "__all__", enabled: true },
    });
    check(
      "P2 global kill switch off/on round trip",
      off.status === 200 && row?.enabled === false && on.status === 200,
      `off=${off.status} row=${JSON.stringify(row)} on=${on.status}`,
    );
  }
  {
    const r = await req("GET", "/platform/agent-policies", { user: userA, dealerId: 2 });
    check("P3 dealer user cannot read policies → 403", r.status === 403, `got ${r.status}`);
  }

}

async function main() {
  // Completion validation runs suites concurrently. P0 temporarily changes
  // dealer 2 and the global agent policy that this suite exercises.
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
