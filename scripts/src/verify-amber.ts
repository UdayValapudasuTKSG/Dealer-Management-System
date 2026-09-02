import crypto from "node:crypto";
import { pool } from "@workspace/db";

// Verification suite for the Amber Connect telematics module.
// Runs against the DEV api-server via the dev-only x-test-user-email header.
// Covers: default-off entitlement, enable/disable behavior, secret
// redaction, dealer isolation, VIN-confirmed mapping + conflicts,
// duplicate/out-of-order events, webhook signature + entitlement gating.

const BASE = process.env.API_BASE ?? "http://localhost:80/api";
const developmentDatabaseUrl =
  process.env.DEV_DATABASE_URL ?? process.env.DATABASE_URL;

// Dev-DB allowlist guard (never run fixtures against prod).
if (
  developmentDatabaseUrl &&
  /neon|amazonaws|prod/i.test(process.env.PROD_DATABASE_URL ?? "") &&
  developmentDatabaseUrl === process.env.PROD_DATABASE_URL
) {
  console.error("Refusing to run: development database points at production");
  process.exit(1);
}

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail: string) {
  if (cond) {
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

async function webhook(
  dealerId: number,
  payload: unknown,
  secret: string | null,
) {
  const raw = Buffer.from(JSON.stringify(payload), "utf8");
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (secret) {
    headers["x-amber-signature"] =
      "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
  }
  const res = await fetch(`${BASE}/webhooks/amber/${dealerId}`, {
    method: "POST",
    headers,
    body: raw,
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* ignore */
  }
  return { status: res.status, json };
}

const GM1 = "amber-test-gm1@aura-test.local"; // dealer 1 GM
const GM2 = "amber-test-gm2@aura-test.local"; // dealer 2 GM
const VIN = "AMBERTESTVIN000001";

async function setEntitlement(dealerId: number, on: boolean | null) {
  if (on === null) {
    await pool.query(
      `UPDATE dealers SET entitlements = coalesce(entitlements, '{}'::jsonb) - 'amber_connect' WHERE id = $1`,
      [dealerId],
    );
  } else {
    await pool.query(
      `UPDATE dealers SET entitlements = coalesce(entitlements, '{}'::jsonb) || jsonb_build_object('amber_connect', $2::boolean) WHERE id = $1`,
      [dealerId, on],
    );
  }
}

async function cleanup() {
  await pool.query(`DELETE FROM amber_events WHERE dealer_id IN (1,2) AND external_id LIKE 'ambertest-%'`);
  await pool.query(`DELETE FROM amber_vehicle_states WHERE device_id LIKE 'AMBERTEST%'`);
  await pool.query(`DELETE FROM amber_devices WHERE device_id LIKE 'AMBERTEST%'`);
  await pool.query(`DELETE FROM amber_connections WHERE dealer_id IN (1,2)`);
  await pool.query(`DELETE FROM vehicles WHERE vin = $1 OR vin = 'AMBERTESTVIN000002'`, [VIN]);
  await pool.query(`DELETE FROM dealer_users WHERE user_id IN (SELECT id FROM users WHERE email IN ($1,$2))`, [GM1, GM2]);
  await pool.query(`DELETE FROM users WHERE email IN ($1,$2)`, [GM1, GM2]);
  await setEntitlement(1, null);
  await setEntitlement(2, null);
}

async function main() {
  await cleanup();

  const gmRole = await pool
    .query(`SELECT id FROM roles WHERE name = 'General Manager' AND is_system = true LIMIT 1`)
    .then((r) => r.rows[0]?.id as number | undefined);
  if (!gmRole) throw new Error("General Manager role not found");

  for (const [email, dealerId, tag] of [
    [GM1, 1, "gm1"],
    [GM2, 2, "gm2"],
  ] as const) {
    const userId = await pool
      .query(
        `INSERT INTO users (clerk_id, email, name, status) VALUES ($1, $2, 'Amber Test GM', 'active') RETURNING id`,
        [`amber-test-${tag}-${Date.now()}`, email],
      )
      .then((r) => r.rows[0].id as number);
    await pool.query(
      `INSERT INTO dealer_users (dealer_id, user_id, role_id) VALUES ($1, $2, $3)`,
      [dealerId, userId, gmRole],
    );
  }

  const [vehicleRow] = await pool
    .query(
      `INSERT INTO vehicles (dealer_id, vin, make, model, year, price, powertrain, mileage_km, exterior_color, body_type, status)
       VALUES (1, $1, 'AmberTest', 'Tracker', 2026, 10000, 'gas', 1000, 'Black', 'SUV', 'in_stock') RETURNING id`,
      [VIN],
    )
    .then((r) => r.rows);
  const vehicleId = vehicleRow.id as number;

  try {
    console.log("\n1. Default-off entitlement");
    {
      const r = await call("GET", "/amber/settings", GM1, 1);
      check("missing entitlement key → 404", r.status === 404, `got ${r.status}`);
      await setEntitlement(1, false);
      const r2 = await call("GET", "/amber/settings", GM1, 1);
      check("explicit false → 404", r2.status === 404, `got ${r2.status}`);
      await setEntitlement(1, true);
      const r3 = await call("GET", "/amber/settings", GM1, 1);
      check("enabled → 200", r3.status === 200, `got ${r3.status}`);
      check(
        "unconfigured contractStatus = pending_documentation",
        r3.json?.contractStatus === "pending_documentation",
        JSON.stringify(r3.json),
      );
    }

    console.log("\n2. Connection settings + secret redaction");
    {
      const r = await call("PUT", "/amber/settings", GM1, 1, {
        apiBaseUrl: "https://api.amber.example",
        apiKey: "supersecret-amber-key-12345",
      });
      check("GM can save settings", r.status === 200, `got ${r.status} ${JSON.stringify(r.json)}`);
      const body = JSON.stringify(r.json ?? {});
      check(
        "API key never echoed",
        !body.includes("supersecret-amber-key-12345"),
        "plaintext key found in response",
      );
      check("hint present", r.json?.apiKeyHint === "supe", JSON.stringify(r.json?.apiKeyHint));
      const ct = await pool
        .query(`SELECT api_key_ciphertext FROM amber_connections WHERE dealer_id = 1`)
        .then((q) => q.rows[0]?.api_key_ciphertext as string);
      check(
        "credential stored encrypted",
        !!ct && !ct.includes("supersecret") && ct.split(":").length === 3,
        ct ?? "missing",
      );
      const t = await call("POST", "/amber/settings/test", GM1, 1);
      check(
        "test reports pending_contract (no fabricated call)",
        t.status === 200 && t.json?.status === "pending_contract",
        `${t.status} ${JSON.stringify(t.json)}`,
      );
      const en = await call("PUT", "/amber/settings", GM1, 1, { enabled: true });
      check("GM can enable connection", en.status === 200 && en.json?.enabled === true, `${en.status}`);
    }

    console.log("\n3. Dealer isolation");
    {
      const r = await call("GET", "/amber/settings", GM2, 2);
      check("dealer 2 (no entitlement) → 404", r.status === 404, `got ${r.status}`);
      const r2 = await call("GET", "/amber/settings", GM2, 1);
      check("non-member header → 403", r2.status === 403, `got ${r2.status}`);
      await setEntitlement(2, true);
      const r3 = await call("GET", "/amber/devices", GM2, 2);
      check("dealer 2 sees no dealer-1 devices", r3.status === 200 && Array.isArray(r3.json) && r3.json.length === 0, `${r3.status} ${JSON.stringify(r3.json)}`);
    }

    console.log("\n4. Device registration + VIN-confirmed mapping");
    let deviceRowId = 0;
    {
      const r = await call("POST", "/amber/devices", GM1, 1, {
        deviceId: "AMBERTEST-DEV-1",
        reportedVin: VIN,
      });
      check("register device", r.status === 200, `got ${r.status} ${JSON.stringify(r.json)}`);
      deviceRowId = r.json?.id;
      const bad = await call("POST", `/amber/devices/${deviceRowId}/map`, GM1, 1, {
        vehicleId,
        confirmVin: "WRONGVIN123",
      });
      check("wrong VIN confirmation → 409", bad.status === 409, `got ${bad.status}`);
      const ok = await call("POST", `/amber/devices/${deviceRowId}/map`, GM1, 1, {
        vehicleId,
        confirmVin: VIN.toLowerCase(),
      });
      check("VIN-confirmed mapping succeeds", ok.status === 200 && ok.json?.mappingStatus === "mapped", `${ok.status} ${JSON.stringify(ok.json)}`);
      // Second device against the same vehicle → conflict
      const r2 = await call("POST", "/amber/devices", GM1, 1, { deviceId: "AMBERTEST-DEV-2" });
      const conflict = await call("POST", `/amber/devices/${r2.json?.id}/map`, GM1, 1, {
        vehicleId,
        confirmVin: VIN,
      });
      check("second device on same vehicle → 409 conflict", conflict.status === 409, `got ${conflict.status}`);
      const list = await call("GET", "/amber/devices", GM1, 1);
      const dev2 = (list.json ?? []).find((d: any) => d.deviceId === "AMBERTEST-DEV-2");
      check("conflict state recorded", dev2?.mappingStatus === "conflict", JSON.stringify(dev2));
    }

    console.log("\n5. Webhook signature + idempotent/out-of-order events");
    {
      const secret = await pool
        .query(`SELECT webhook_secret FROM amber_connections WHERE dealer_id = 1`)
        .then((q) => q.rows[0]?.webhook_secret as string);
      const evt = (id: string, over: Record<string, unknown> = {}) => ({
        externalId: id,
        deviceId: "AMBERTEST-DEV-1",
        type: "odometer",
        occurredAt: "2026-08-30T12:00:00Z",
        odometerKm: 1500,
        ...over,
      });
      const unsigned = await webhook(1, evt("ambertest-1"), null);
      check("unsigned webhook → 403", unsigned.status === 403, `got ${unsigned.status}`);
      const badsig = await webhook(1, evt("ambertest-1"), "wrong-secret");
      check("bad signature → 403", badsig.status === 403, `got ${badsig.status}`);
      const ok = await webhook(1, evt("ambertest-1"), secret);
      check("signed event processed", ok.status === 200 && ok.json?.results?.processed === 1, `${ok.status} ${JSON.stringify(ok.json)}`);
      const dup = await webhook(1, evt("ambertest-1"), secret);
      check("duplicate externalId → duplicate (no reprocess)", dup.json?.results?.duplicate === 1, JSON.stringify(dup.json));
      const older = await webhook(1, evt("ambertest-0", { occurredAt: "2026-08-30T10:00:00Z", odometerKm: 1400 }), secret);
      check("out-of-order older event → stale", older.json?.results?.stale === 1, JSON.stringify(older.json));
      const state = await pool
        .query(`SELECT odometer_km FROM amber_vehicle_states WHERE dealer_id = 1 AND device_id = 'AMBERTEST-DEV-1'`)
        .then((q) => q.rows[0]);
      check("state kept newest odometer", Number(state?.odometer_km) === 1500, JSON.stringify(state));
      const veh = await pool
        .query(`SELECT mileage_km FROM vehicles WHERE id = $1`, [vehicleId])
        .then((q) => q.rows[0]);
      check("vehicle mileage raised (never lowered)", Number(veh?.mileage_km) === 1500, JSON.stringify(veh));
      // Cross-dealer: dealer 2 must not see dealer 1 telemetry
      const fleet2 = await call("GET", "/amber/fleet", GM2, 2);
      check("dealer 2 fleet empty", fleet2.status === 200 && fleet2.json?.length === 0, JSON.stringify(fleet2.json));
      const status1 = await call("GET", `/amber/vehicles/${vehicleId}/status`, GM1, 1);
      check("vehicle status mapped + fresh label", status1.status === 200 && status1.json?.mapped === true && !!status1.json?.freshness, JSON.stringify(status1.json));
    }

    console.log("\n5b. Concurrency: parallel webhooks + parallel mapping");
    {
      const secret = await pool
        .query(`SELECT webhook_secret FROM amber_connections WHERE dealer_id = 1`)
        .then((q) => q.rows[0]?.webhook_secret as string);
      // Fire a burst of out-of-order events for one device concurrently —
      // the final state must be the newest values regardless of arrival order.
      const mk = (i: number, hour: number, odo: number) => ({
        externalId: `ambertest-conc-${i}`,
        deviceId: "AMBERTEST-DEV-1",
        type: "odometer",
        occurredAt: `2026-08-30T${String(hour).padStart(2, "0")}:00:00Z`,
        odometerKm: odo,
      });
      const burst = [mk(1, 14, 1700), mk(2, 18, 2100), mk(3, 15, 1800), mk(4, 17, 2000), mk(5, 16, 1900)];
      const rs = await Promise.all(burst.map((b) => webhook(1, b, secret)));
      check("concurrent burst all accepted", rs.every((r) => r.status === 200), JSON.stringify(rs.map((r) => r.status)));
      const st = await pool
        .query(`SELECT odometer_km, odometer_at, last_event_at FROM amber_vehicle_states WHERE dealer_id = 1 AND device_id = 'AMBERTEST-DEV-1'`)
        .then((q) => q.rows[0]);
      check("concurrent state kept newest odometer (2100)", Number(st?.odometer_km) === 2100, JSON.stringify(st));
      check(
        "concurrent state kept newest timestamps",
        new Date(st?.odometer_at).toISOString() === "2026-08-30T18:00:00.000Z" &&
          new Date(st?.last_event_at).toISOString() === "2026-08-30T18:00:00.000Z",
        JSON.stringify(st),
      );
      // Same externalId in parallel → exactly one row (idempotency under race).
      const dupBurst = await Promise.all([1, 2, 3].map(() => webhook(1, mk(99, 19, 2200), secret)));
      const dupProcessed = dupBurst.reduce((n, r) => n + (r.json?.results?.processed ?? 0), 0);
      check("parallel duplicate externalId processed exactly once", dupProcessed === 1, JSON.stringify(dupBurst.map((r) => r.json?.results)));
      const dupCnt = await pool
        .query(`SELECT count(*)::int AS n FROM amber_events WHERE external_id = 'ambertest-conc-99'`)
        .then((q) => q.rows[0].n as number);
      check("exactly one stored event row", dupCnt === 1, `stored ${dupCnt}`);

      // Concurrent mapping: two devices race to map the same vehicle — the
      // partial unique index must let exactly one win.
      const [v2] = await pool
        .query(
          `INSERT INTO vehicles (dealer_id, vin, make, model, year, price, powertrain, mileage_km, exterior_color, body_type, status)
           VALUES (1, 'AMBERTESTVIN000002', 'AmberTest', 'Racer', 2026, 10000, 'gas', 0, 'White', 'SUV', 'in_stock') RETURNING id`,
        )
        .then((q) => q.rows);
      const vehicle2 = v2.id as number;
      const regIds: number[] = [];
      for (const dev of ["AMBERTEST-DEV-3", "AMBERTEST-DEV-4"]) {
        const r = await call("POST", "/amber/devices", GM1, 1, { deviceId: dev });
        regIds.push(r.json?.id);
      }
      const mapBody = { vehicleId: vehicle2, confirmVin: "AMBERTESTVIN000002" };
      const [m1, m2] = await Promise.all(
        regIds.map((id) => call("POST", `/amber/devices/${id}/map`, GM1, 1, mapBody)),
      );
      const oks = [m1, m2].filter((m) => m.status === 200).length;
      const conflicts = [m1, m2].filter((m) => m.status === 409).length;
      check("concurrent mapping: exactly one wins", oks === 1 && conflicts === 1, `${m1.status}/${m2.status}`);
      const mappedCnt = await pool
        .query(`SELECT count(*)::int AS n FROM amber_devices WHERE dealer_id = 1 AND vehicle_id = $1`, [vehicle2])
        .then((q) => q.rows[0].n as number);
      check("exactly one device mapped to vehicle", mappedCnt === 1, `mapped ${mappedCnt}`);
      await pool.query(`DELETE FROM vehicles WHERE vin = 'AMBERTESTVIN000002'`);

      // Equal-timestamp conflicting values: a second distinct event at an
      // already-recorded timestamp must be stale and must NOT touch mileage.
      const eq1 = await webhook(1, mk(200, 20, 2300), secret);
      check("equal-ts baseline processed", eq1.json?.results?.processed === 1, JSON.stringify(eq1.json));
      const eq2 = await webhook(1, { ...mk(201, 20, 9999) }, secret);
      check("equal-timestamp conflicting event → stale", eq2.json?.results?.stale === 1, JSON.stringify(eq2.json));
      const eqState = await pool
        .query(`SELECT odometer_km FROM amber_vehicle_states WHERE dealer_id = 1 AND device_id = 'AMBERTEST-DEV-1'`)
        .then((q) => q.rows[0]);
      check("equal-ts state kept first value", Number(eqState?.odometer_km) === 2300, JSON.stringify(eqState));
      const eqVeh = await pool
        .query(`SELECT mileage_km FROM vehicles WHERE id = $1`, [vehicleId])
        .then((q) => q.rows[0]);
      check("equal-ts rejected value never reached vehicle mileage", Number(eqVeh?.mileage_km) === 2300, JSON.stringify(eqVeh));

      // Unmap vs webhook: after unmap, a new event must NOT restore the old
      // vehicle linkage on the state row.
      const dev1Id = await pool
        .query(`SELECT id FROM amber_devices WHERE dealer_id = 1 AND device_id = 'AMBERTEST-DEV-1'`)
        .then((q) => q.rows[0].id as number);
      const un = await call("POST", `/amber/devices/${dev1Id}/unmap`, GM1, 1);
      check("unmap succeeds", un.status === 200, `got ${un.status}`);
      const after = await webhook(1, mk(300, 21, 2400), secret);
      check("post-unmap event is unmapped, not processed", after.json?.results?.unmapped === 1, JSON.stringify(after.json));
      const unState = await pool
        .query(`SELECT vehicle_id FROM amber_vehicle_states WHERE dealer_id = 1 AND device_id = 'AMBERTEST-DEV-1'`)
        .then((q) => q.rows[0]);
      check("state vehicle link stays cleared after unmap", unState?.vehicle_id == null, JSON.stringify(unState));
      // Restore mapping so the race test below starts from a mapped device.
      const remap = await call("POST", `/amber/devices/${dev1Id}/map`, GM1, 1, { vehicleId, confirmVin: VIN });
      check("remap after unmap succeeds", remap.status === 200, `got ${remap.status}`);

      // Deterministic unmap-vs-webhook interleaving: hold the shared
      // per-device advisory lock, queue the unmap FIRST, then the webhook.
      // On release they serialize in queue order — unmap wins, then the
      // webhook must see the cleared mapping and touch NO vehicle.
      const lockClient = await pool.connect();
      try {
        await lockClient.query("BEGIN");
        await lockClient.query(
          `SELECT pg_advisory_xact_lock(hashtext('amber:1:AMBERTEST-DEV-1'))`,
        );
        const mileageBefore = await pool
          .query(`SELECT mileage_km FROM vehicles WHERE id = $1`, [vehicleId])
          .then((q) => Number(q.rows[0].mileage_km));
        const unmapP = call("POST", `/amber/devices/${dev1Id}/unmap`, GM1, 1);
        await new Promise((r) => setTimeout(r, 500));
        const whP = webhook(1, mk(400, 22, 999999), secret);
        await new Promise((r) => setTimeout(r, 500));
        await lockClient.query("COMMIT"); // release — unmap then webhook
        const [unmapRes, whRes] = await Promise.all([unmapP, whP]);
        check("race: unmap completed", unmapRes.status === 200, `got ${unmapRes.status}`);
        check(
          "race: webhook after unmap → unmapped (no vehicle side effects)",
          whRes.json?.results?.unmapped === 1,
          JSON.stringify(whRes.json),
        );
        const mileageAfter = await pool
          .query(`SELECT mileage_km FROM vehicles WHERE id = $1`, [vehicleId])
          .then((q) => Number(q.rows[0].mileage_km));
        check("race: former vehicle mileage untouched", mileageAfter === mileageBefore, `${mileageBefore} → ${mileageAfter}`);
        const tCnt = await pool
          .query(
            `SELECT count(*)::int AS n FROM timeline_events WHERE dealer_id = 1 AND ref_type = 'vehicle' AND ref_id = $1 AND kind = 'telematics' AND detail LIKE '%999,999%'`,
            [vehicleId],
          )
          .then((q) => q.rows[0].n as number);
        check("race: no timeline entry on former vehicle", tCnt === 0, `found ${tCnt}`);
        const raceState = await pool
          .query(`SELECT vehicle_id FROM amber_vehicle_states WHERE dealer_id = 1 AND device_id = 'AMBERTEST-DEV-1'`)
          .then((q) => q.rows[0]);
        check("race: state link stays cleared", raceState?.vehicle_id == null, JSON.stringify(raceState));
      } finally {
        lockClient.release();
      }
      // Restore mapping so section 6 disable checks run against a mapped device.
      const remap2 = await call("POST", `/amber/devices/${dev1Id}/map`, GM1, 1, { vehicleId, confirmVin: VIN });
      check("remap for disable checks", remap2.status === 200, `got ${remap2.status}`);
    }

    console.log("\n6. Disable stops everything immediately");
    {
      const secret = await pool
        .query(`SELECT webhook_secret FROM amber_connections WHERE dealer_id = 1`)
        .then((q) => q.rows[0]?.webhook_secret as string);
      await setEntitlement(1, false);
      const r = await call("GET", "/amber/fleet", GM1, 1);
      check("API blocked after disable → 404", r.status === 404, `got ${r.status}`);
      const wh = await webhook(
        1,
        { externalId: "ambertest-blocked", deviceId: "AMBERTEST-DEV-1", type: "odometer", occurredAt: "2026-08-30T13:00:00Z", odometerKm: 1600 },
        secret,
      );
      check("webhook blocked after disable → 404", wh.status === 404, `got ${wh.status}`);
      const cnt = await pool
        .query(`SELECT count(*)::int AS n FROM amber_events WHERE external_id = 'ambertest-blocked'`)
        .then((q) => q.rows[0].n as number);
      check("no event stored while disabled", cnt === 0, `stored ${cnt}`);
      await setEntitlement(1, true);
    }
  } finally {
    await cleanup();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(failures.map((f) => ` - ${f}`).join("\n"));
    process.exit(1);
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
