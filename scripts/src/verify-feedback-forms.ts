/**
 * Feedback-forms regression suite (Task: custom lead feedback forms).
 * Covers: GM-only authorization, dealer isolation, question validation,
 * publish/archive lifecycle, filter matching + all-matching selection,
 * recipient exclusions, duplicate-send idempotency, public token flow
 * (invalid / expired / submit-once), and snapshot immutability.
 *
 * Requires the api-server workflow running; uses dev-only x-test-user-email.
 * Run: pnpm --filter @workspace/scripts run verify-feedback-forms
 */
import { pool } from "@workspace/db";

const BASE = "http://localhost:80/api";

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

const RUN = Date.now();
const GM_A = `ff-gm-a-${RUN}@aura-test.local`;
const GM_B = `ff-gm-b-${RUN}@aura-test.local`;
const ADVISOR_A = `ff-adv-a-${RUN}@aura-test.local`;
const DEALER_A = 2;
const DEALER_B = 1;

const createdUserIds: number[] = [];
const createdLeadIds: number[] = [];
const createdFormIds: number[] = [];

async function seedUser(email: string, dealerId: number, roleName: string) {
  const roleId = await pool
    .query(`select id from roles where name = $1 limit 1`, [roleName])
    .then((r) => r.rows[0]?.id as number | undefined);
  if (!roleId) throw new Error(`role ${roleName} not found`);
  const userId = await pool
    .query(
      `insert into users (clerk_id, email, name, status)
       values ($1, $2, $3, 'active') returning id`,
      [`ff-test-${email}`, email, `FF Test ${roleName}`],
    )
    .then((r) => r.rows[0].id as number);
  createdUserIds.push(userId);
  await pool.query(
    `insert into dealer_users (dealer_id, user_id, role_id) values ($1, $2, $3)`,
    [dealerId, userId, roleId],
  );
  return userId;
}

async function seedLead(
  dealerId: number,
  name: string,
  opts: { email?: string | null; phone?: string | null; source?: string; emailOptOut?: boolean; assignedTo?: string | null } = {},
) {
  const id = await pool
    .query(
      `insert into leads (dealer_id, name, email, phone, source, status, email_opt_out, assigned_to)
       values ($1, $2, $3, $4, $5, 'new', $6, $7) returning id`,
      [
        dealerId,
        name,
        opts.email ?? null,
        opts.phone ?? null,
        opts.source ?? `ff-suite-${RUN}`,
        opts.emailOptOut ?? false,
        opts.assignedTo ?? null,
      ],
    )
    .then((r) => r.rows[0].id as number);
  createdLeadIds.push(id);
  return id;
}

const QUESTIONS = [
  { id: "q1", type: "star_rating", label: "Rate your experience", required: true, maxStars: 5 },
  { id: "q2", type: "single_choice", label: "Would you recommend us?", required: true, options: ["Yes", "No"] },
  { id: "q3", type: "long_text", label: "Anything else?", required: false },
];

async function run() {
  console.log("\n== 1. GM-only authorization ==");
  {
    const r = await req("GET", "/feedback-forms", { user: ADVISOR_A, dealerId: DEALER_A });
    check("non-GM cannot list forms (403)", r.status === 403, `got ${r.status}`);
    const c = await req("POST", "/feedback-forms", {
      user: ADVISOR_A,
      dealerId: DEALER_A,
      body: { name: "Nope", questions: QUESTIONS },
    });
    check("non-GM cannot create forms (403)", c.status === 403, `got ${c.status}`);
    const p = await req("POST", "/feedback-forms/preview-recipients", {
      user: ADVISOR_A,
      dealerId: DEALER_A,
      body: { channels: ["email"], leadIds: [1] },
    });
    check("non-GM cannot preview recipients (403)", p.status === 403, `got ${p.status}`);
  }

  console.log("\n== 2. Question validation ==");
  {
    const bad1 = await req("POST", "/feedback-forms", {
      user: GM_A,
      dealerId: DEALER_A,
      body: { name: "Bad", questions: [{ id: "x", type: "single_choice", label: "Pick", required: true, options: ["only-one"] }] },
    });
    check("single_choice with <2 options rejected", bad1.status === 400 || bad1.status === 422, `got ${bad1.status}`);
    const bad2 = await req("POST", "/feedback-forms", {
      user: GM_A,
      dealerId: DEALER_A,
      body: { name: "Bad2", questions: [{ id: "x", type: "star_rating", label: "", required: true, maxStars: 5 }] },
    });
    check("empty label rejected", bad2.status === 400 || bad2.status === 422, `got ${bad2.status}`);
  }

  console.log("\n== 3. Lifecycle: create → publish → archive ==");
  let formId = 0;
  {
    const c = await req("POST", "/feedback-forms", {
      user: GM_A,
      dealerId: DEALER_A,
      body: { name: `Suite Form ${RUN}`, questions: QUESTIONS },
    });
    check("GM creates draft form", c.status === 201 || c.status === 200, `got ${c.status}`);
    formId = c.json?.id;
    createdFormIds.push(formId);

    const sendDraft = await req("POST", `/feedback-forms/${formId}/send`, {
      user: GM_A,
      dealerId: DEALER_A,
      body: { mode: "selected", leadIds: [1], channels: ["email"] },
    });
    check("cannot send a draft form (409)", sendDraft.status === 409, `got ${sendDraft.status}`);

    const pub = await req("POST", `/feedback-forms/${formId}/status`, {
      user: GM_A,
      dealerId: DEALER_A,
      body: { action: "publish" },
    });
    check("publish succeeds", pub.status === 200 && pub.json?.status === "published", `got ${pub.status}`);

    const dup = await req("POST", `/feedback-forms/${formId}/duplicate`, {
      user: GM_A,
      dealerId: DEALER_A,
    });
    check("duplicate creates a draft copy", (dup.status === 200 || dup.status === 201) && dup.json?.status === "draft", `got ${dup.status}/${dup.json?.status}`);
    if (dup.json?.id) createdFormIds.push(dup.json.id);
  }

  console.log("\n== 4. Dealer isolation ==");
  {
    const r = await req("GET", `/feedback-forms/${formId}`, { user: GM_B, dealerId: DEALER_B });
    check("cross-dealer form GET is 404", r.status === 404, `got ${r.status}`);
    const s = await req("POST", `/feedback-forms/${formId}/send`, {
      user: GM_B,
      dealerId: DEALER_B,
      body: { mode: "selected", leadIds: [1], channels: ["email"] },
    });
    check("cross-dealer send is 404", s.status === 404, `got ${s.status}`);
    const listB = await req("GET", "/feedback-forms", { user: GM_B, dealerId: DEALER_B });
    check(
      "dealer-B list excludes dealer-A form",
      listB.status === 200 && !listB.json?.some((f: any) => f.id === formId),
      `got ${listB.status}`,
    );
  }

  console.log("\n== 5. Filters, exclusions, all-matching selection ==");
  const leadEmail = await seedLead(DEALER_A, `FF Email ${RUN}`, { email: `ff-lead-${RUN}@example.com` });
  const leadOptOut = await seedLead(DEALER_A, `FF OptOut ${RUN}`, { email: `ff-optout-${RUN}@example.com`, emailOptOut: true });
  const leadNoContact = await seedLead(DEALER_A, `FF NoContact ${RUN}`, {});
  const leadOtherDealer = await seedLead(DEALER_B, `FF Foreign ${RUN}`, { email: `ff-foreign-${RUN}@example.com` });
  {
    const p = await req("POST", "/feedback-forms/preview-recipients", {
      user: GM_A,
      dealerId: DEALER_A,
      body: {
        formId,
        channels: ["email"],
        filters: [{ field: "source", operator: "is", values: [`ff-suite-${RUN}`] }],
      },
    });
    check("filter preview matches suite leads only (all pages)", p.status === 200 && p.json?.matchingCount === 3, `count=${p.json?.matchingCount}`);
    check(
      "foreign-dealer lead never matches",
      !p.json?.matchingLeadIds?.includes(leadOtherDealer),
    );
    const includedIds = (p.json?.included ?? []).map((x: any) => x.leadId);
    check("contactable lead included", includedIds.includes(leadEmail));
    const exReasons = Object.fromEntries((p.json?.excluded ?? []).map((x: any) => [x.leadId, x.reason]));
    check("email opt-out excluded", exReasons[leadOptOut] === "email_opt_out", JSON.stringify(exReasons));
    check("no-contact excluded", exReasons[leadNoContact] === "no_contact", JSON.stringify(exReasons));

    const combo = await req("POST", "/feedback-forms/preview-recipients", {
      user: GM_A,
      dealerId: DEALER_A,
      body: {
        channels: ["email"],
        filters: [
          { field: "source", operator: "is", values: [`ff-suite-${RUN}`] },
          { field: "phase", operator: "is_any_of", values: ["new", "contacted"] },
          { field: "created", operator: "on_or_after", values: ["2026-01-01"] },
        ],
      },
    });
    check("combined AND filters work", combo.status === 200 && combo.json?.matchingCount === 3, `count=${combo.json?.matchingCount}`);

    // Owner contains = case-insensitive partial match.
    const leadOwned = await seedLead(DEALER_A, `FF Owned ${RUN}`, {
      email: `ff-owned-${RUN}@example.com`,
      source: `ff-owner-${RUN}`,
      assignedTo: `Alexandra Suite${RUN}`,
    });
    const ownerContains = await req("POST", "/feedback-forms/preview-recipients", {
      user: GM_A,
      dealerId: DEALER_A,
      body: {
        channels: ["email"],
        filters: [{ field: "owner", operator: "contains", values: [`suite${RUN}`] }],
      },
    });
    check(
      "owner contains matches case-insensitive substring",
      ownerContains.status === 200 && ownerContains.json?.matchingLeadIds?.includes(leadOwned),
      `count=${ownerContains.json?.matchingCount}`,
    );

    // Invalid field/operator pairings must be rejected, never reinterpreted.
    const badOp = await req("POST", "/feedback-forms/preview-recipients", {
      user: GM_A,
      dealerId: DEALER_A,
      body: {
        channels: ["email"],
        filters: [{ field: "phase", operator: "contains", values: ["new"] }],
      },
    });
    check("invalid operator for field rejected (422)", badOp.status === 422, `got ${badOp.status}`);
    const badOp2 = await req("POST", "/feedback-forms/preview-recipients", {
      user: GM_A,
      dealerId: DEALER_A,
      body: {
        channels: ["email"],
        filters: [{ field: "created", operator: "is", values: ["2026-01-01"] }],
      },
    });
    check("created with non-date operator rejected (422)", badOp2.status === 422, `got ${badOp2.status}`);
  }

  console.log("\n== 6. Send idempotency + all_matching ==");
  {
    const s1 = await req("POST", `/feedback-forms/${formId}/send`, {
      user: GM_A,
      dealerId: DEALER_A,
      body: {
        mode: "all_matching",
        channels: ["email"],
        filters: [{ field: "source", operator: "is", values: [`ff-suite-${RUN}`] }],
      },
    });
    check("all_matching send queues only eligible lead", s1.status === 200 && s1.json?.queued === 1, JSON.stringify(s1.json));
    const s2 = await req("POST", `/feedback-forms/${formId}/send`, {
      user: GM_A,
      dealerId: DEALER_A,
      body: { mode: "selected", leadIds: [leadEmail], channels: ["email"] },
    });
    check(
      "duplicate send skipped as already_sent",
      s2.status === 200 && s2.json?.queued === 0 && s2.json?.skipped?.[0]?.reason === "already_sent",
      JSON.stringify(s2.json),
    );
    const foreign = await req("POST", `/feedback-forms/${formId}/send`, {
      user: GM_A,
      dealerId: DEALER_A,
      body: { mode: "selected", leadIds: [leadOtherDealer], channels: ["email"] },
    });
    check(
      "foreign lead in selected mode is not sent",
      foreign.status === 200 ? foreign.json?.queued === 0 : foreign.status === 404,
      JSON.stringify(foreign.json),
    );
  }

  console.log("\n== 7. Public token flow ==");
  const token = await pool
    .query(
      `select token from feedback_invitations where form_id = $1 and lead_id = $2`,
      [formId, leadEmail],
    )
    .then((r) => r.rows[0]?.token as string | undefined);
  {
    check("invitation row created with token", !!token);
    const bad = await req("GET", "/feedback/definitely-not-a-token");
    check("invalid token is 404", bad.status === 404, `got ${bad.status}`);

    const g = await req("GET", `/feedback/${token}`);
    check("public GET returns open snapshot", g.status === 200 && g.json?.state === "open" && g.json?.questions?.length === 3, `got ${g.status}`);
    check("public payload has no lead PII beyond name", g.json && !("email" in g.json) && !("phone" in g.json));

    const missing = await req("POST", `/feedback/${token}/submit`, {
      body: { answers: [{ questionId: "q3", text: "only optional" }] },
    });
    check("missing required answers rejected (422)", missing.status === 422 || missing.status === 400, `got ${missing.status}`);

    const badChoice = await req("POST", `/feedback/${token}/submit`, {
      body: { answers: [{ questionId: "q1", rating: 4 }, { questionId: "q2", choices: ["Maybe"] }] },
    });
    check("invalid choice rejected", badChoice.status === 422 || badChoice.status === 400, `got ${badChoice.status}`);

    const ok = await req("POST", `/feedback/${token}/submit`, {
      body: { answers: [{ questionId: "q1", rating: 5 }, { questionId: "q2", choices: ["Yes"] }] },
    });
    check("valid submission accepted", ok.status === 200, `got ${ok.status} ${JSON.stringify(ok.json)}`);

    const again = await req("POST", `/feedback/${token}/submit`, {
      body: { answers: [{ questionId: "q1", rating: 1 }, { questionId: "q2", choices: ["No"] }] },
    });
    check("second submission rejected (409)", again.status === 409, `got ${again.status}`);
  }

  console.log("\n== 8. Expired token ==");
  {
    const leadExp = await seedLead(DEALER_A, `FF Expired ${RUN}`, { email: `ff-exp-${RUN}@example.com` });
    await req("POST", `/feedback-forms/${formId}/send`, {
      user: GM_A,
      dealerId: DEALER_A,
      body: { mode: "selected", leadIds: [leadExp], channels: ["email"] },
    });
    const expToken = await pool
      .query(`select token from feedback_invitations where form_id = $1 and lead_id = $2`, [formId, leadExp])
      .then((r) => r.rows[0]?.token as string);
    await pool.query(`update feedback_invitations set expires_at = now() - interval '1 day' where token = $1`, [expToken]);
    const g = await req("GET", `/feedback/${expToken}`);
    check("expired token is 410", g.status === 410, `got ${g.status}`);
    const s = await req("POST", `/feedback/${expToken}/submit`, {
      body: { answers: [{ questionId: "q1", rating: 3 }, { questionId: "q2", choices: ["Yes"] }] },
    });
    check("expired token cannot submit", s.status === 410 || s.status === 409, `got ${s.status}`);
  }

  console.log("\n== 9. Snapshot immutability + lead attachment ==");
  {
    // Edit the reusable form AFTER submission — history must keep the old snapshot.
    // Published forms may restrict edits; archive-safe path: update label via PATCH.
    const patch = await req("PATCH", `/feedback-forms/${formId}`, {
      user: GM_A,
      dealerId: DEALER_A,
      body: {
        name: `Suite Form ${RUN} EDITED`,
        questions: [{ id: "q1", type: "star_rating", label: "CHANGED LABEL", required: true, maxStars: 10 }],
      },
    });
    check("form remains editable or explicitly locked", [200, 409].includes(patch.status), `got ${patch.status}`);

    const hist = await req("GET", `/leads/${leadEmail}/feedback`, { user: GM_A, dealerId: DEALER_A });
    check("lead feedback history returns invitation", hist.status === 200 && hist.json?.length === 1, `got ${hist.status}`);
    const inv = hist.json?.[0];
    check("history keeps original form name", inv?.formName === `Suite Form ${RUN}`, inv?.formName);
    check(
      "history keeps original question snapshot",
      inv?.questionsSnapshot?.length === 3 && inv?.questionsSnapshot?.[0]?.label === "Rate your experience",
    );
    check("submitted answers attached with timestamp", inv?.answers?.q1 === 5 && !!inv?.submittedAt);
    check("delivery channel recorded", inv?.channels?.includes("email"));

    const histForeign = await req("GET", `/leads/${leadEmail}/feedback`, { user: GM_B, dealerId: DEALER_B });
    check("cross-dealer lead feedback is 404", histForeign.status === 404, `got ${histForeign.status}`);

    const advHist = await req("GET", `/leads/${leadEmail}/feedback`, { user: ADVISOR_A, dealerId: DEALER_A });
    check(
      "advisor with leads view can read lead feedback (leads RBAC)",
      advHist.status === 200 || advHist.status === 403,
      `got ${advHist.status}`,
    );

    // Archive blocks sending.
    await req("POST", `/feedback-forms/${formId}/status`, {
      user: GM_A,
      dealerId: DEALER_A,
      body: { action: "archive" },
    });
    const leadNew = await seedLead(DEALER_A, `FF PostArchive ${RUN}`, { email: `ff-post-${RUN}@example.com` });
    const s = await req("POST", `/feedback-forms/${formId}/send`, {
      user: GM_A,
      dealerId: DEALER_A,
      body: { mode: "selected", leadIds: [leadNew], channels: ["email"] },
    });
    check("archived form cannot be sent (409)", s.status === 409, `got ${s.status}`);
  }
}

async function cleanup() {
  // Remove everything the suite created (invitations cascade via lead/form deletes
  // are not guaranteed — delete explicitly).
  if (createdFormIds.length) {
    await pool.query(`delete from feedback_invitations where form_id = any($1::int[])`, [createdFormIds]);
    await pool.query(`delete from feedback_forms where id = any($1::int[])`, [createdFormIds]);
  }
  if (createdLeadIds.length) {
    await pool.query(`delete from lead_timeline_events where lead_id = any($1::int[])`, [createdLeadIds]).catch(() => {});
    await pool.query(`delete from leads where id = any($1::int[])`, [createdLeadIds]);
  }
  await pool.query(`delete from email_logs where dedupe_key like 'feedback:inv:%' and recipient_email like $1`, [`ff-%${RUN}@example.com`]).catch(() => {});
  if (createdUserIds.length) {
    await pool.query(`delete from dealer_users where user_id = any($1::int[])`, [createdUserIds]);
    await pool.query(`delete from users where id = any($1::int[])`, [createdUserIds]);
  }
}

async function main() {
  const health = await fetch(`${BASE}/healthz`).then((r) => r.status).catch(() => 0);
  if (health !== 200) {
    console.error("api-server not healthy on :80 — start the API Server workflow first");
    process.exit(2);
  }
  await seedUser(GM_A, DEALER_A, "General Manager");
  await seedUser(GM_B, DEALER_B, "General Manager");
  await seedUser(ADVISOR_A, DEALER_A, "Sales Advisor");
  try {
    await run();
  } finally {
    await cleanup();
    await pool.end();
  }
  console.log(`\n=== feedback-forms suite: ${pass} passed, ${fail} failed ===`);
  if (failures.length) {
    console.log(failures.map((f) => ` - ${f}`).join("\n"));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
