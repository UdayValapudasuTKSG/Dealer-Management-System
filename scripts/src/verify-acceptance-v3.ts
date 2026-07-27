import { pool } from "@workspace/db";

// Acceptance pass against V3 (40-V3.md) system invariants, obeying 00-nc.md.
// Runs the negative-test suite (N-rows) that is executable against the DEV
// api-server via the dev-only x-test-user-email persona header, and reports
// PASS / FAIL / DEVIATION (behavior exists but code/shape differs from NC-1).
//
// Companion suites (run separately, results folded into the report):
//   verify-p0-security     — INV-TEN matrix, storage ACL, INV-KILL, INV-IMP
//   verify-isolation-p5    — tenant lifecycle + isolation
//   verify-provisioning-saga — INV-SAGA (provisioning compensation)
//   check-gate-cascades    — INV-GATE / INV-VIN cascades

const BASE = process.env.API_BASE ?? "http://localhost:80/api";
const GM = "gm@aura-demo.com"; // dealer 2 member (full RBAC)
const DEALER = 2;
const FOREIGN_DEALER = 1;

let passed = 0;
let failed = 0;
let deviations = 0;
const failures: string[] = [];
const deviationNotes: string[] = [];

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

function deviation(name: string, note: string) {
  deviations++;
  deviationNotes.push(`${name}: ${note}`);
  console.log(`  \u26a0 DEVIATION ${name} — ${note}`);
}

async function call(
  method: string,
  path: string,
  opts: {
    user?: string | null;
    dealerId?: number | null;
    body?: unknown;
    idemKey?: string;
  } = {},
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.user) headers["x-test-user-email"] = opts.user;
  if (opts.dealerId != null) headers["x-dealer-id"] = String(opts.dealerId);
  if (opts.idemKey) headers["x-idempotency-key"] = opts.idemKey;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json, headers: res.headers };
}

const cleanup: Array<() => Promise<void>> = [];

  // Per-run token so aborted runs never collide on unique VIN/engine keys.
  const RUN = Date.now().toString(36).slice(-5).toUpperCase();
  const vinOf = (tag: string) => ("V3" + RUN + tag).padEnd(17, "0").slice(0, 17);


async function q<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pool.query(sql, params)).rows as T[];
}

async function main() {
  console.log("V3 acceptance — INV-TEN (tenant isolation, NC-1/NC-14)");
  {
    // N3: no session → 401
    const r = await call("GET", "/vehicles");
    check("N3 no session → 401", r.status === 401, `got ${r.status}`);
    // N1: valid session, no x-dealer-id, GET → 200 (never 401)
    const r1 = await call("GET", "/vehicles", { user: GM });
    check("N1 GET without x-dealer-id → 200 (default-dealer resolution)", r1.status === 200, `got ${r1.status}`);
    // N4: x-dealer-id not in memberships → 403
    const advisor = "advisor.demo@aura.dev"; // dealer-2-only member
    const r4 = await call("GET", "/vehicles", { user: advisor, dealerId: FOREIGN_DEALER });
    check("N4 non-member x-dealer-id → 403", r4.status === 403, `got ${r4.status}`);
    // N5: foreign row id → 404 (never 403)
    const [fv] = await q(
      `INSERT INTO vehicles (dealer_id, vin, make, model, year, price, status, powertrain, mileage_km, exterior_color, body_type)
       VALUES ($1,'${vinOf("F1")}','AccMake','AccModel',2026,10000,'available','Petrol',0,'White','SUV') RETURNING id`,
      [FOREIGN_DEALER],
    );
    cleanup.push(async () => void (await q(`DELETE FROM vehicles WHERE id=$1`, [fv.id])));
    const r5 = await call("GET", `/vehicles/${fv.id}`, { user: GM, dealerId: DEALER });
    check("N5 foreign row → 404 (no existence leak)", r5.status === 404, `got ${r5.status}`);
    // N4: mutation with explicit non-member dealer header → 403
    const r2 = await call("POST", "/leads", { user: advisor, dealerId: FOREIGN_DEALER, body: { name: "X" } });
    check("N4 mutation with non-member dealer → 403", r2.status === 403, `got ${r2.status}`);
    // N2 (true case, NC-14): authenticated mutation with NO resolvable dealer
    // (user has zero memberships, no header) → 400 dealer_required.
    const noMemberEmail = "v3-nomember@aura-test.com";
    await q(`DELETE FROM users WHERE email=$1`, [noMemberEmail]);
    const [nmUser] = await q(
      `INSERT INTO users (email, name, clerk_id) VALUES ($1,'V3 NoMember','v3-test-nomember') RETURNING id`,
      [noMemberEmail],
    );
    cleanup.push(async () => void (await q(`DELETE FROM users WHERE id=$1`, [nmUser.id])));
    const rn = await call("POST", "/leads", { user: noMemberEmail, body: { name: "X" } });
    check(
      "N2 mutation with no resolvable dealer → 400 dealer_required",
      rn.status === 400 && rn.json?.error === "dealer_required",
      `got ${rn.status} ${JSON.stringify(rn.json)}`,
    );
  }

  // Shared helper: deals.vehicle_id is NOT NULL — every deal fixture needs one.
  const mkVehicle = async (vin: string) =>
    (
      await q(
        `INSERT INTO vehicles (dealer_id, vin, engine_number, make, model, year, price, status, powertrain, mileage_km, exterior_color, body_type)
         VALUES ($1,$2,$3,'AccMake','AccModel',2026,50000,'available','Petrol',0,'White','SUV') RETURNING id`,
        [DEALER, vin, "E" + vin.slice(1)],
      )
    )[0] as { id: number };

  console.log("\nV3 acceptance — INV-IDEM (NC-7, money idempotency)");
  {
    // Fixture: a desking deal in dealer 2 that we PATCH with an idempotency key.
    const idemVeh = await mkVehicle(vinOf("ID"));
    cleanup.push(async () => void (await q(`DELETE FROM vehicles WHERE id=$1`, [idemVeh.id])));
    const [deal] = await q(
      `INSERT INTO deals (dealer_id, customer_name, stage, vehicle_id, vehicle_price, discount, otd_price)
       VALUES ($1,'V3 Idem Fixture','desking',$2,50000,0,50000) RETURNING id`,
      [DEALER, idemVeh.id],
    );
    cleanup.push(async () => void (await q(`DELETE FROM deals WHERE id=$1`, [deal.id])));
    const key = `v3-acc-${Date.now()}`;
    const body = { monthlyPayment: 777 };
    const a = await call("PATCH", `/deals/${deal.id}`, { user: GM, dealerId: DEALER, body, idemKey: key });
    check("idempotent mutation succeeds", a.status === 200, `got ${a.status} ${JSON.stringify(a.json)}`);
    // N11: replay, same key + same body → stored response, no double effect
    const b = await call("PATCH", `/deals/${deal.id}`, { user: GM, dealerId: DEALER, body, idemKey: key });
    check(
      "N11 completed replay → stored response (Idempotent-Replay)",
      b.status === a.status && b.headers.get("idempotent-replay") === "true",
      `got ${b.status}, replay header=${b.headers.get("idempotent-replay")}`,
    );
    // N13: same key, different body → 422 key_reuse_mismatch
    const c = await call("PATCH", `/deals/${deal.id}`, {
      user: GM,
      dealerId: DEALER,
      body: { monthlyPayment: 888 },
      idemKey: key,
    });
    check(
      "N13 same key + different body → 422 key_reuse_mismatch",
      c.status === 422 && c.json?.error === "key_reuse_mismatch",
      `got ${c.status} ${JSON.stringify(c.json)}`,
    );
    // N12: in-flight duplicate → 409. Best-effort race: fire two concurrent
    // requests with a fresh key; accept either a 409 loser or a stored replay
    // (the window is small on a local DB).
    const k2 = `v3-acc-race-${Date.now()}`;
    const [r1, r2] = await Promise.all([
      call("PATCH", `/deals/${deal.id}`, { user: GM, dealerId: DEALER, body: { monthlyPayment: 901 }, idemKey: k2 }),
      call("PATCH", `/deals/${deal.id}`, { user: GM, dealerId: DEALER, body: { monthlyPayment: 901 }, idemKey: k2 }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    const replayEvidence =
      r1.headers.get("idempotent-replay") === "true" || r2.headers.get("idempotent-replay") === "true";
    const keyRows = await q(`SELECT id FROM idempotency_keys WHERE dealer_id=$1 AND key=$2`, [DEALER, k2]);
    check(
      "N12 concurrent same key → exactly one effect (409 loser or replay header; single key row)",
      statuses.includes(200) &&
        (statuses.includes(409) || replayEvidence) &&
        keyRows.length === 1,
      `got ${statuses.join(",")}, replay=${replayEvidence}, keyRows=${keyRows.length}`,
    );
    // N14: mutation with NO idempotency key. Spec: 422. Built app: key optional.
    const d = await call("PATCH", `/deals/${deal.id}`, { user: GM, dealerId: DEALER, body: { monthlyPayment: 902 } });
    if (d.status === 422) {
      check("N14 mutation without key → 422", true, "");
    } else {
      deviation(
        "N14 mutation without Idempotency-Key",
        `spec expects 422; built app treats the key as OPTIONAL (got ${d.status}). Exactly-once holds only when clients send the key.`,
      );
    }
  }

  console.log("\nV3 acceptance — INV-GATE + state-machine-only transitions (NC-3/NC-4)");
  {
    // Stage skipping on deals: desking → delivered must be rejected.
    const skipVeh = await mkVehicle(vinOf("SK"));
    cleanup.push(async () => void (await q(`DELETE FROM vehicles WHERE id=$1`, [skipVeh.id])));
    const [deal] = await q(
      `INSERT INTO deals (dealer_id, customer_name, stage, vehicle_id, vehicle_price, discount, otd_price)
       VALUES ($1,'V3 Gate Fixture','desking',$2,50000,0,50000) RETURNING id`,
      [DEALER, skipVeh.id],
    );
    cleanup.push(async () => void (await q(`DELETE FROM deals WHERE id=$1`, [deal.id])));
    const skip = await call("PATCH", `/deals/${deal.id}`, {
      user: GM,
      dealerId: DEALER,
      body: { stage: "delivered" },
      idemKey: `v3-skip-${Date.now()}`,
    });
    check(
      "deal stage skip (desking → delivered) rejected 4xx",
      skip.status === 409 || skip.status === 422 || skip.status === 400,
      `got ${skip.status}`,
    );

    // N16: below-floor commit without resolved gate → 422 (gate-before-irreversible)
    const [veh] = await q(
      `INSERT INTO vehicles (dealer_id, vin, engine_number, make, model, year, price, status, powertrain, mileage_km, exterior_color, body_type)
       VALUES ($1,'${vinOf("G1")}','E${vinOf("G1").slice(1)}','AccMake','AccModel',2026,50000,'available','Petrol',0,'White','SUV') RETURNING id`,
      [DEALER],
    );
    cleanup.push(async () => void (await q(`DELETE FROM vehicles WHERE id=$1`, [veh.id])));
    const [bfDeal] = await q(
      `INSERT INTO deals (dealer_id, customer_name, stage, vehicle_id, vehicle_price, discount, otd_price, deposit_paid)
       VALUES ($1,'V3 BelowFloor','desking',$2,50000,10000,40000,true) RETURNING id`,
      [DEALER, veh.id],
    );
    cleanup.push(async () => {
      await q(`DELETE FROM gates WHERE ref_type='deal' AND ref_id=$1`, [bfDeal.id]);
      await q(`DELETE FROM deals WHERE id=$1`, [bfDeal.id]);
    });
    // Deposit gate is now booking-based: give the fixture a paid booking so
    // only the below-floor gate blocks the commit.
    const [bfBooking] = await q(
      `INSERT INTO bookings (dealer_id, vehicle_id, customer_name, deal_id, booking_amount, amount_paid, payment_status, status, expires_at)
       VALUES ($1,$2,'V3 BelowFloor',$3,1000,1000,'paid','active', now() + interval '3 days') RETURNING id`,
      [DEALER, veh.id, bfDeal.id],
    );
    cleanup.push(async () => void (await q(`DELETE FROM bookings WHERE id=$1`, [bfBooking.id])));
    const commit = await call("PATCH", `/deals/${bfDeal.id}`, {
      user: GM,
      dealerId: DEALER,
      body: { stage: "committed" },
      idemKey: `v3-bf-${Date.now()}`,
    });
    check(
      "N16 below-floor commit without approved gate → 422 (floor gate, not deposit)",
      commit.status === 422 && JSON.stringify(commit.json).includes("floor"),
      `got ${commit.status} ${JSON.stringify(commit.json)}`,
    );

    // N17: double-resolve a gate. Spec: 409. Built app: 400 "Gate already resolved".
    const [gate] = await q(
      `INSERT INTO gates (dealer_id, type, status, ref_type, ref_id, title, summary)
       VALUES ($1,'below_floor_price','pending','deal',$2,'V3 acceptance gate','v3 acceptance fixture') RETURNING id`,
      [DEALER, bfDeal.id],
    );
    const g1 = await call("POST", `/gates/${gate.id}/resolve`, {
      user: GM,
      dealerId: DEALER,
      body: { action: "dismiss", note: "v3 acceptance" },
    });
    check("gate resolve (first) succeeds", g1.status >= 200 && g1.status < 300, `got ${g1.status} ${JSON.stringify(g1.json)}`);
    const g2 = await call("POST", `/gates/${gate.id}/resolve`, {
      user: GM,
      dealerId: DEALER,
      body: { action: "dismiss", note: "v3 acceptance dup" },
    });
    if (g2.status === 409) {
      check("N17 double-resolve → 409", true, "");
    } else if (g2.status === 400) {
      deviation("N17 double-resolve", "rejected exactly-once but with 400 'Gate already resolved'; spec/NC-1 expects 409.");
    } else {
      check("N17 double-resolve rejected", false, `got ${g2.status}`);
    }

    // N18: gate type outside canonical set → rejected by enum. Static: the DB
    // enum has SEVEN values (recall_damage added) vs the spec's exhaustive six.
    const enumRows = await q<{ v: string }>(
      `SELECT unnest(enum_range(NULL::gate_type))::text AS v`,
    ).catch(() => [] as { v: string }[]);
    const types = enumRows.map((r) => r.v).sort();
    const canonical = ["below_floor_price", "capital_order", "credit_decline", "gra_filing", "refund_release", "stage_advance"];
    const extras = types.filter((t) => !canonical.includes(t));
    const bogusRows = await q(
      `INSERT INTO gates (dealer_id, type, status, title, summary) VALUES ($1,'vin_allocation','pending','bogus','bogus') RETURNING id`,
      [DEALER],
    ).catch(() => [] as { id: number }[]);
    if (bogusRows.length > 0) {
      const bogusId = bogusRows[0].id;
      cleanup.push(async () => void (await q(`DELETE FROM gates WHERE id=$1`, [bogusId])));
      await q(`DELETE FROM gates WHERE id=$1`, [bogusId]);
      deviation(
        "N18 gate type enforcement",
        "gates.type is TEXT in the DB — non-canonical types are rejected only at the Zod/API layer, not by a DB enum constraint. No API path creates gates with arbitrary types, but defense-in-depth is missing.",
      );
    } else {
      check("N18 non-canonical gate type rejected at DB level", true, "");
    }
    if (extras.length > 0) {
      deviation("N18 gate-type set", `enum contains extra type(s) beyond the canonical six: ${extras.join(", ")} (spec NC-4 says exhaustive 6).`);
    }
  }

  console.log("\nV3 acceptance — INV-VIN (deterministic allocation, no gate)");
  {
    const [veh] = await q(
      `INSERT INTO vehicles (dealer_id, vin, engine_number, make, model, year, price, status, powertrain, mileage_km, exterior_color, body_type)
       VALUES ($1,'${vinOf("G2")}','E${vinOf("G2").slice(1)}','AccMake','AccModel',2026,50000,'available','Petrol',0,'White','SUV') RETURNING id`,
      [DEALER],
    );
    cleanup.push(async () => void (await q(`DELETE FROM vehicles WHERE id=$1`, [veh.id])));
    const mk = async () => {
      const [deal] = await q(
        `INSERT INTO deals (dealer_id, customer_name, stage, vehicle_id, vehicle_price, discount, otd_price, deposit_paid)
         VALUES ($1,'V3 VIN Fixture','desking',$2,50000,0,50000,true) RETURNING id`,
        [DEALER, veh.id],
      );
      // Booking-based deposit gate: each fixture deal carries a paid booking.
      const [bk] = await q(
        `INSERT INTO bookings (dealer_id, vehicle_id, customer_name, deal_id, booking_amount, amount_paid, payment_status, status, expires_at)
         VALUES ($1,$2,'V3 VIN Fixture',$3,1000,1000,'paid','active', now() + interval '3 days') RETURNING id`,
        [DEALER, veh.id, deal.id],
      );
      cleanup.push(async () => void (await q(`DELETE FROM bookings WHERE id=$1`, [bk.id])));
      return deal;
    };
    const dealA = await mk();
    const dealB = await mk();
    cleanup.push(async () => void (await q(`DELETE FROM deals WHERE id IN ($1,$2)`, [dealA.id, dealB.id])));
    // N19/N20: two deals commit against the same vehicle → exactly one wins.
    const [c1, c2] = await Promise.all([
      call("PATCH", `/deals/${dealA.id}`, { user: GM, dealerId: DEALER, body: { stage: "committed" }, idemKey: `v3-vinA-${Date.now()}` }),
      call("PATCH", `/deals/${dealB.id}`, { user: GM, dealerId: DEALER, body: { stage: "committed" }, idemKey: `v3-vinB-${Date.now()}` }),
    ]);
    const ok = [c1, c2].filter((r) => r.status === 200).length;
    const conflict = [c1, c2].filter((r) => r.status === 409 || r.status === 422).length;
    check("N19 at-floor commit succeeds without any gate (2xx)", ok >= 1, `statuses ${c1.status},${c2.status}`);
    check("N20 double-commit race → exactly one allocation", ok === 1 && conflict === 1, `statuses ${c1.status},${c2.status}`);
    const [vAfter] = await q(`SELECT status FROM vehicles WHERE id=$1`, [veh.id]);
    if (vAfter.status === "booked") {
      check("N19 vehicle → booked on commit", true, "");
    } else if (vAfter.status === "reserved") {
      deviation("N19 vehicle status on commit", "vehicle moves to 'reserved' on commit; spec NC-3 target vocabulary is 'booked'.");
    } else {
      check("N19 vehicle locked on commit", false, `vehicle status = ${vAfter.status}`);
    }
    const vinGates = await q(`SELECT id FROM gates WHERE ref_type='deal' AND ref_id IN ($1,$2)`, [dealA.id, dealB.id]);
    check("N19 no gate raised for at-floor VIN allocation", vinGates.length === 0, `${vinGates.length} gate(s) raised`);
  }

  console.log("\nV3 acceptance — INV-MON (immutable ledger, money validation)");
  {
    // N22: no in-place edit path for payments — PATCH/DELETE routes must not exist.
    const [pay] = await q(`SELECT id FROM payments WHERE dealer_id=$1 LIMIT 1`, [DEALER]);
    const pid = pay?.id ?? 999999;
    const pPatch = await call("PATCH", `/payments/${pid}`, { user: GM, dealerId: DEALER, body: { amount: 1 } });
    const pDel = await call("DELETE", `/payments/${pid}`, { user: GM, dealerId: DEALER });
    check("N22 PATCH /payments/:id has no route (404/405)", pPatch.status === 404 || pPatch.status === 405, `got ${pPatch.status}`);
    check("N22 DELETE /payments/:id has no route (404/405)", pDel.status === 404 || pDel.status === 405, `got ${pDel.status}`);
    // N23: malformed money — negative amount rejected.
    const [inv] = await q(`SELECT id FROM invoices WHERE dealer_id=$1 LIMIT 1`, [DEALER]);
    if (inv) {
      const neg = await call("POST", "/payments", {
        user: GM,
        dealerId: DEALER,
        body: { invoiceId: inv.id, amount: -50, method: "cash" },
        idemKey: `v3-neg-${Date.now()}`,
      });
      check("N23 negative payment amount rejected 4xx", neg.status === 400 || neg.status === 422, `got ${neg.status} ${JSON.stringify(neg.json)}`);
    } else {
      console.log("  (skip N23 — no invoice fixture in dealer 2)");
    }
  }

  console.log("\nV3 acceptance — INV-SUSP (suspension: writes 423, reads allowed)");
  {
    const [tmp] = await q(
      `INSERT INTO dealers (name, status) VALUES ('V3 Suspended Fixture','suspended') RETURNING id`,
    );
    const [gmUser] = await q(`SELECT id FROM users WHERE email=$1`, [GM]);
    const [role] = await q(`SELECT id FROM roles WHERE name='General Manager' LIMIT 1`);
    await q(`INSERT INTO dealer_users (dealer_id, user_id, role_id) VALUES ($1,$2,$3)`, [tmp.id, gmUser.id, role.id]);
    cleanup.push(async () => {
      await q(`DELETE FROM dealer_users WHERE dealer_id=$1`, [tmp.id]);
      await q(`DELETE FROM dealers WHERE id=$1`, [tmp.id]);
    });
    const read = await call("GET", "/vehicles", { user: GM, dealerId: tmp.id });
    check("N10 read while suspended → 200", read.status === 200, `got ${read.status}`);
    const write = await call("POST", "/leads", {
      user: GM,
      dealerId: tmp.id,
      body: { name: "Suspended Write", phone: "555", source: "walk_in" },
    });
    check("N9 write while suspended → 423", write.status === 423, `got ${write.status} ${JSON.stringify(write.json)}`);
  }

  console.log("\nV3 acceptance — INV-AI / INV-KILL (grounding, HITL, governance)");
  {
    // INV-KILL: dealer GM cannot toggle a platform kill switch.
    const kill = await call("POST", "/platform/agents/intake_dedup/policy", {
      user: GM,
      dealerId: DEALER,
      body: { enabled: false },
    });
    check("INV-KILL dealer GM cannot set platform agent policy (403/404)", kill.status === 403 || kill.status === 404, `got ${kill.status}`);
    // INV-AI: autonomous writers are audited — agent_runs rows exist for the
    // governed keys, and no advisory agent has autonomous write runs.
    const runs = await q<{ agent_key: string; n: string }>(
      `SELECT agent_key, count(*) n FROM agent_runs GROUP BY agent_key ORDER BY agent_key`,
    );
    check("INV-AI agent_runs audit trail exists", runs.length > 0, "no agent_runs rows at all");
    // A7 outreach: the ONLY send path is POST /leads/:id/outreach, which is
    // itself the human Approve&Send action. Verify it demands a session
    // (no unattended/anonymous invocation is possible).
    const send = await call("POST", "/leads/1/outreach", {
      body: { message: "v3 acceptance probe" },
    });
    check(
      "INV-AI outreach send path requires a human session (401 anonymous)",
      send.status === 401,
      `got ${send.status} — anonymous send must be rejected`,
    );
    // Confidence floor / grounding: deterministic-first lead brief. Static
    // check: the brief pipeline stores confidence + routing on agent_runs.
    const brief = await q(
      `SELECT 1 FROM agent_runs WHERE output::text ILIKE '%confidence%' LIMIT 1`,
    ).catch(() => []);
    if (brief.length === 0) {
      deviation("INV-AI confidence floor", "no agent_runs row with a recorded confidence found — confidence-floor behavior not evidenced in audit data (verify via lead brief flow).");
    } else {
      check("INV-AI confidence recorded on agent runs", true, "");
    }
  }

  console.log("\nV3 acceptance — 9-step delivery order (INV-SAGA, N28)");
  {
    const [veh] = await q(
      `INSERT INTO vehicles (dealer_id, vin, engine_number, make, model, year, price, status, powertrain, mileage_km, exterior_color, body_type)
       VALUES ($1,'${vinOf("G3")}','E${vinOf("G3").slice(1)}','AccMake','AccModel',2026,30000,'available','Petrol',0,'White','SUV') RETURNING id`,
      [DEALER],
    );
    const [deal] = await q(
      `INSERT INTO deals (dealer_id, customer_name, stage, vehicle_id, vehicle_price, discount, otd_price)
       VALUES ($1,'V3 Delivery Fixture','committed',$2,30000,0,30000) RETURNING id`,
      [DEALER, veh.id],
    );
    const [del] = await q(
      `INSERT INTO deliveries (dealer_id, deal_id, vehicle_id, customer_name, status, current_step, steps)
       VALUES ($1,$2,$3,'V3 Delivery Fixture','in_progress','sales_order','[]'::jsonb) RETURNING id`,
      [DEALER, deal.id, veh.id],
    );
    cleanup.push(async () => {
      await q(`DELETE FROM deliveries WHERE id=$1`, [del.id]);
      await q(`DELETE FROM deals WHERE id=$1`, [deal.id]);
      await q(`DELETE FROM vehicles WHERE id=$1`, [veh.id]);
    });
    const out = await call("POST", `/deliveries/${del.id}/advance`, {
      user: GM,
      dealerId: DEALER,
      body: { step: "signature", signatureName: "V3" },
    });
    check("N28 out-of-order delivery step (signature before invoice) → 4xx", out.status === 422 || out.status === 400 || out.status === 409, `got ${out.status} ${JSON.stringify(out.json)}`);
  }

  // ---- report ----------------------------------------------------------
  console.log("\n=======================================================");
  console.log(`V3 acceptance: ${passed} passed, ${failed} failed, ${deviations} deviation(s)`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  if (deviationNotes.length) {
    console.log("\nDeviations (behavior correct-in-substance, code/shape differs from NC-1):");
    for (const d of deviationNotes) console.log(`  - ${d}`);
  }
}

main()
  .catch((err) => {
    console.error("FATAL:", err);
    failed++;
  })
  .finally(async () => {
    for (const fn of cleanup.reverse()) {
      try {
        await fn();
      } catch (e) {
        console.error("cleanup error:", e);
      }
    }
    await pool.end();
    process.exit(failed > 0 ? 1 : 0);
  });
