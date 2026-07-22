// Fail-closed regression suite for the dealer onboarding SAGA (P1/P2 spec):
// durable per-step markers, resume-on-retry, reverse compensation on abort,
// go-live gate (422 {unmet:[]}), and Clerk JIT owner-invite binding.
//
// Run: pnpm --filter @workspace/scripts run verify-provisioning-saga
// Requires the api-server workflow running in dev (x-test-user-email honored).

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

const BASE = process.env.API_BASE ?? "http://localhost:80/api";
const SUPER_ADMIN =
  process.env.SUPER_ADMIN_EMAIL?.split(",")[0]?.trim() ??
  "uday.valapudasu@theksquaregroup.com";

const STAMP = Date.now();
const DEALER_A = `Saga Verify A ${STAMP}`;
const DEALER_B = `Saga Verify B ${STAMP}`;
const OWNER_EMAIL = `saga.owner.${STAMP}@example.com`;

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function api(
  method: string,
  path: string,
  opts: { user?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-test-user-email": opts.user ?? SUPER_ADMIN,
      ...(opts.headers ?? {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json };
}

type Step = { stepKey: string; status: string; attempts: number };
const stepMap = (saga: any): Map<string, Step> =>
  new Map((saga?.steps ?? []).map((s: Step) => [s.stepKey, s]));

async function main() {
  const dealerIds: number[] = [];
  let ownerUserId: number | null = null;

  try {
    // ---- 1. Happy path: create → all steps done, status provisioning ----
    console.log("\n[1] Happy-path creation");
    const created = await api("POST", "/platform/dealers", {
      body: { name: DEALER_A, city: "Georgetown", ownerEmail: OWNER_EMAIL },
    });
    check("create returns 201", created.status === 201, `got ${created.status}`);
    const dealerA = created.json?.dealer?.id;
    if (dealerA) dealerIds.push(dealerA);
    const sagaA = created.json?.saga;
    check(
      "dealer starts in provisioning",
      created.json?.dealer?.status === "provisioning",
    );
    check(
      "all 10 steps recorded done",
      sagaA?.steps?.length === 10 &&
        sagaA.steps.every((s: Step) => s.status === "done"),
    );
    check(
      "go-live blocked only on owner invite",
      Array.isArray(sagaA?.unmet) &&
        sagaA.unmet.length === 1 &&
        sagaA.unmet[0] === "owner_invite_accepted",
      JSON.stringify(sagaA?.unmet),
    );

    // ---- 2. Activation gate: 422 {unmet:[]} while invite pending ----
    console.log("\n[2] Go-live gate");
    const early = await api("POST", `/platform/dealers/${dealerA}/activate`);
    check("activate before invite → 422", early.status === 422, `got ${early.status}`);
    check(
      "422 body carries unmet[]",
      Array.isArray(early.json?.unmet) && early.json.unmet.includes("owner_invite_accepted"),
    );

    // ---- 3. Clerk JIT binding: owner signs in → membership + invite accepted ----
    console.log("\n[3] JIT owner binding");
    const ins = await db.execute(
      sql`insert into users (clerk_id, email, name, created_by)
          values (${`saga_verify_${STAMP}`}, ${OWNER_EMAIL}, 'Saga Verify Owner', 'verify-script')
          returning id`,
    );
    ownerUserId = (ins.rows[0] as any).id;
    const me = await api("GET", "/auth/me", { user: OWNER_EMAIL });
    const membership = (me.json?.dealers ?? []).find(
      (d: any) => d.dealerId === dealerA,
    );
    check("owner gains membership on first contact", !!membership);
    check(
      "membership is General Manager",
      membership?.roleName === "General Manager" && membership?.isGeneralManager === true,
    );
    const inv = await db.execute(
      sql`select status from dealer_invites where dealer_id = ${dealerA}`,
    );
    check("invite marked accepted", (inv.rows[0] as any)?.status === "accepted");

    // ---- 4. Activation succeeds once checklist clears ----
    const act = await api("POST", `/platform/dealers/${dealerA}/activate`);
    check("activate after invite → 200 active", act.status === 200 && act.json?.status === "active");
    const reAct = await api("POST", `/platform/dealers/${dealerA}/activate`);
    check("re-activate (not provisioning) → 422", reAct.status === 422);

    // ---- 5. Injected failure halts run; later steps stay pending ----
    console.log("\n[5] Failure + resume");
    const createdB = await api("POST", "/platform/dealers", {
      body: { name: DEALER_B, ownerEmail: `b.${OWNER_EMAIL}` },
      headers: { "x-provisioning-fail-step": "seed_agents" },
    });
    const dealerB = createdB.json?.dealer?.id;
    if (dealerB) dealerIds.push(dealerB);
    const stepsB = stepMap(createdB.json?.saga);
    check("injected step recorded failed", stepsB.get("seed_agents")?.status === "failed");
    check(
      "subsequent steps stay pending",
      stepsB.get("invite_owner_admin")?.status === "pending" &&
        stepsB.get("register_los")?.status === "pending",
    );
    check(
      "resumableFrom points at failed step",
      createdB.json?.saga?.resumableFrom === "seed_agents",
    );

    // ---- 6. Retry resumes from the failed step (done steps not re-run) ----
    const retry = await api(
      "POST",
      `/platform/dealers/${dealerB}/provisioning/retry`,
    );
    check("retry returns 202", retry.status === 202, `got ${retry.status}`);
    const stepsB2 = stepMap(retry.json);
    check(
      "retry completes all steps",
      [...stepsB2.values()].every((s) => s.status === "done"),
    );
    check(
      "failed step re-attempted (attempts=2)",
      stepsB2.get("seed_agents")?.attempts === 2,
    );
    check(
      "completed steps NOT re-run (attempts=1)",
      stepsB2.get("seed_divisions")?.attempts === 1,
    );

    // ---- 6b. In-flight claim → 409; stale claim is taken over ----
    await db.execute(
      sql`update provisioning_steps set status = 'in_progress', started_at = now()
          where dealer_id = ${dealerB} and step_key = 'register_los'`,
    );
    const inflight = await api(
      "POST",
      `/platform/dealers/${dealerB}/provisioning/retry`,
    );
    check("retry while saga in flight → 409", inflight.status === 409, `got ${inflight.status}`);
    await db.execute(
      sql`update provisioning_steps set started_at = now() - interval '10 minutes'
          where dealer_id = ${dealerB} and step_key = 'register_los'`,
    );
    const takeover = await api(
      "POST",
      `/platform/dealers/${dealerB}/provisioning/retry`,
    );
    check("stale in-flight claim taken over → 202", takeover.status === 202, `got ${takeover.status}`);
    check(
      "orphaned step re-run to done",
      stepMap(takeover.json).get("register_los")?.status === "done",
    );

    // ---- 7. Abort compensates in reverse and closes the dealer ----
    console.log("\n[7] Abort + compensation");
    const abort = await api(
      "POST",
      `/platform/dealers/${dealerB}/provisioning/abort`,
      { body: { reason: "verify-script abort test" } },
    );
    check("abort returns 202", abort.status === 202, `got ${abort.status}`);
    check("dealer closed after abort", abort.json?.status === "closed");
    check(
      "all steps compensated",
      (abort.json?.steps ?? []).every((s: Step) => s.status === "compensated"),
    );
    const seeded = await db.execute(
      sql`select
         (select count(*) from divisions where dealer_id = ${dealerB})::int as divisions,
         (select count(*) from agents where dealer_id = ${dealerB})::int as agents,
         (select count(*) from lead_sources where dealer_id = ${dealerB})::int as sources,
         (select count(*) from stage_checklists where dealer_id = ${dealerB})::int as checklists`,
    );
    const c = seeded.rows[0] as any;
    check(
      "seeded rows removed by compensation",
      c.divisions === 0 && c.agents === 0 && c.sources === 0 && c.checklists === 0,
      JSON.stringify(c),
    );
    const roleCount = await db.execute(sql`select count(*)::int as n from roles`);
    check("global roles NOT deleted by compensation", (roleCount.rows[0] as any).n > 0);
    const retryClosed = await api(
      "POST",
      `/platform/dealers/${dealerB}/provisioning/retry`,
    );
    check("retry on closed dealer → 422", retryClosed.status === 422);

    // ---- 8. Status endpoint ----
    const status = await api("GET", `/platform/dealers/${dealerA}/provisioning`);
    check("GET provisioning returns 200", status.status === 200);
    check("GET provisioning on unknown id → 404", (await api("GET", "/platform/dealers/999999/provisioning")).status === 404);
  } finally {
    // ---- Cleanup ----
    for (const id of dealerIds) {
      for (const table of [
        "dealer_invites", "provisioning_steps", "dealer_users", "divisions",
        "lead_sources", "dealer_taxes", "stage_checklists", "agents",
        "audit_logs", "email_logs",
      ]) {
        await db.execute(
          sql`delete from ${sql.raw(table)} where dealer_id = ${id}`,
        );
      }
      await db.execute(sql`delete from dealers where id = ${id}`);
    }
    if (ownerUserId) {
      await db.execute(sql`delete from users where id = ${ownerUserId}`);
    }
    }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
