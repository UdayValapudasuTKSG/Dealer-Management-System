/**
 * Collision claims regression suite (Task 279).
 *
 * Covers: dealer isolation, explicit view permission, adjacent-only
 * transitions + approver 403s, one-claim-per-repair-order and claim-number
 * uniqueness 409s, supplement lifecycle independence, backorder cycle-time
 * pauses, split settlement caps, denied/total-loss exits, invoice/close
 * gating and the full intake→closed journey.
 *
 * Requires the api-server workflow running; uses dev-only x-test-user-email.
 * Run: pnpm --filter @workspace/scripts run verify-collision-claims
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

const MANAGER = "collision-test-svcmgr@aura-test.local";
const ADVISOR = "collision-test-advisor@aura-test.local";
const OUTSIDER = "collision-test-sales@aura-test.local";
const TECH = "collision-test-tech@aura-test.local";

async function seedUser(email: string, roleName: string, dealerId: number) {
  await pool.query(`delete from users where lower(email) = $1`, [email]);
  const roleId = await pool
    .query(`select id from roles where name = $1 limit 1`, [roleName])
    .then((r) => r.rows[0]?.id as number | undefined);
  if (!roleId) throw new Error(`role ${roleName} not found`);
  const userId = await pool
    .query(
      `insert into users (clerk_id, email, name, status)
       values ($1, $2, $3, 'active') returning id`,
      [`${email}-${Date.now()}`, email, roleName + " Fixture"],
    )
    .then((r) => r.rows[0].id as number);
  await pool.query(
    `insert into dealer_users (dealer_id, user_id, role_id) values ($1, $2, $3)`,
    [dealerId, userId, roleId],
  );
  return userId;
}

async function main() {
  // Advisory lock: settlement/fixture writes must not interleave with other
  // suites mutating shared demo data (parallel completion validations).
  await pool.query(
    `select pg_advisory_lock(hashtext('aura-verify-collision-claims-v1'))`,
  );
  const created = {
    orders: [] as number[],
    claims: [] as number[],
    jobCards: [] as number[],
    parts: [] as number[],
    invoices: [] as number[],
  };
  try {
    await seedUser(MANAGER, "Service Manager", 2);
    await seedUser(ADVISOR, "Service Advisor", 2);
    await seedUser(OUTSIDER, "Sales Advisor", 2);
    await seedUser(TECH, "Technician", 2);

    const q = async (sqlText: string, params: unknown[] = []) =>
      (await pool.query(sqlText, params)).rows[0]?.id as number;

    // Fixture repair orders (dealer 2) + a foreign one (dealer 1).
    const orderA = await q(
      `insert into service_orders (dealer_id, vehicle_info, customer_name, type, scheduled_date)
       values (2, 'Collision Fixture Hilux', 'Collision Fixture Customer', 'repair', '2026-08-20') returning id`,
    );
    const orderB = await q(
      `insert into service_orders (dealer_id, vehicle_info, type, scheduled_date)
       values (2, 'Collision Fixture Coaster', 'repair', '2026-08-21') returning id`,
    );
    const orderC = await q(
      `insert into service_orders (dealer_id, vehicle_info, type, scheduled_date)
       values (2, 'Collision Fixture Raize', 'repair', '2026-08-22') returning id`,
    );
    const foreignOrder = await q(
      `insert into service_orders (dealer_id, vehicle_info, type, scheduled_date)
       values (1, 'Foreign Collision SUV', 'repair', '2026-08-20') returning id`,
    );
    created.orders.push(orderA, orderB, orderC, foreignOrder);

    const claimBody = {
      serviceOrderId: orderA,
      lossDate: "2026-08-15",
      insurerName: "Assuria Fixture",
      claimNumber: "CLM-FIX-001",
      severity: "moderate",
      initialEstimate: 500000,
      deductible: 50000,
      damagePoints: [{ zone: "front_bumper", severity: "moderate" }],
    };

    console.log("\n== Creation, uniqueness & permissions ==");
    let claimId = 0;
    {
      const r = await req("POST", "/collision-claims", {
        user: ADVISOR,
        dealerId: 2,
        body: claimBody,
      });
      claimId = r.json?.id;
      if (claimId) created.claims.push(claimId);
      check("C1 advisor creates claim → 201", r.status === 201 && !!claimId, `got ${r.status}`);
    }
    {
      // The governed coordinator runs asynchronously after commit. Confirm it
      // records an audited run and uses the retrying/deduplicated email outbox.
      let agentRuns = 0;
      let queuedEmails = 0;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const { rows } = await pool.query(
          `select
             (select count(*)::int from agent_runs
               where dealer_id = 2 and agent_key = 'collision_coordinator'
                 and ref_type = 'collision_claim' and ref_id = $1) as agent_runs,
             (select count(*)::int from email_logs
               where dealer_id = 2
                 and dedupe_key like $2) as queued_emails`,
          [claimId, `collision:claim:${claimId}:created:v1:%`],
        );
        agentRuns = rows[0]?.agent_runs ?? 0;
        queuedEmails = rows[0]?.queued_emails ?? 0;
        if (agentRuns > 0 && queuedEmails > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      check(
        "C1b Collision Coordinator audits the handoff and queues deduplicated staff email",
        agentRuns > 0 && queuedEmails > 0,
        `agent runs ${agentRuns}, emails ${queuedEmails}`,
      );
    }
    {
      const r = await req("POST", "/collision-claims", {
        user: ADVISOR,
        dealerId: 2,
        body: claimBody,
      });
      check("C2 second claim on same repair order → 409", r.status === 409, `got ${r.status}`);
    }
    {
      const invoicedOrder = await q(
        `insert into service_orders
           (dealer_id, vehicle_info, customer_name, type, scheduled_date)
         values
           (2, 'Already Invoiced Collision Fixture', 'Invoice First Customer', 'repair', '2026-08-19')
         returning id`,
      );
      created.orders.push(invoicedOrder);
      const invoicedCard = await q(
        `insert into job_cards
           (dealer_id, service_order_id, title, status, labor_hours, labor_rate)
         values (2, $1, 'Invoice-first card', 'completed', 1, 1000)
         returning id`,
        [invoicedOrder],
      );
      created.jobCards.push(invoicedCard);
      const issued = await req("POST", `/job-cards/${invoicedCard}/invoice`, {
        user: MANAGER,
        dealerId: 2,
      });
      if (issued.json?.id) created.invoices.push(issued.json.id);
      const claimAfterInvoice = await req("POST", "/collision-claims", {
        user: ADVISOR,
        dealerId: 2,
        body: {
          serviceOrderId: invoicedOrder,
          lossDate: "2026-08-18",
          insurerName: "Invoice First Fixture",
          severity: "moderate",
          initialEstimate: 1000,
        },
      });
      check(
        "C2b invoice-first repair cannot later become a collision claim",
        issued.status === 201 && claimAfterInvoice.status === 422,
        `invoice ${issued.status}, claim ${claimAfterInvoice.status}`,
      );
    }
    {
      const raceOrder = await q(
        `insert into service_orders
           (dealer_id, vehicle_info, customer_name, type, scheduled_date)
         values
           (2, 'Claim Invoice Race Fixture', 'Race Customer', 'repair', '2026-08-19')
         returning id`,
      );
      created.orders.push(raceOrder);
      const raceCard = await q(
        `insert into job_cards
           (dealer_id, service_order_id, title, status, labor_hours, labor_rate)
         values (2, $1, 'Claim-invoice race card', 'completed', 1, 1000)
         returning id`,
        [raceOrder],
      );
      created.jobCards.push(raceCard);
      const blocker = await pool.connect();
      await blocker.query("begin");
      await blocker.query(
        `select id from service_orders where id = $1 and dealer_id = 2 for update`,
        [raceOrder],
      );
      const claimPromise = req("POST", "/collision-claims", {
        user: ADVISOR,
        dealerId: 2,
        body: {
          serviceOrderId: raceOrder,
          lossDate: "2026-08-18",
          insurerName: "Race Fixture",
          severity: "moderate",
          initialEstimate: 1000,
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 75));
      const invoicePromise = req("POST", `/job-cards/${raceCard}/invoice`, {
        user: MANAGER,
        dealerId: 2,
      });
      await blocker.query("commit");
      blocker.release();
      const [claimCreated, invoiceBlocked] = await Promise.all([
        claimPromise,
        invoicePromise,
      ]);
      if (claimCreated.json?.id) created.claims.push(claimCreated.json.id);
      if (invoiceBlocked.status === 201 && invoiceBlocked.json?.id) {
        created.invoices.push(invoiceBlocked.json.id);
      }
      const { rows: invalidInvoices } = await pool.query(
        `select id from service_invoices where service_order_id = $1 and dealer_id = 2`,
        [raceOrder],
      );
      check(
        "C2c concurrent claim intake wins shared order lock and blocks pre-signoff invoice",
        claimCreated.status === 201 &&
          invoiceBlocked.status === 422 &&
          invalidInvoices.length === 0,
        `claim ${claimCreated.status}, invoice ${invoiceBlocked.status}, rows ${invalidInvoices.length}`,
      );
    }
    {
      const r = await req("POST", "/collision-claims", {
        user: ADVISOR,
        dealerId: 2,
        body: { ...claimBody, serviceOrderId: orderB, claimNumber: "clm-fix-001" },
      });
      check(
        "C3 duplicate insurer claim number (case-insensitive) → 409",
        r.status === 409,
        `got ${r.status}`,
      );
    }
    {
      const r = await req("POST", "/collision-claims", {
        user: ADVISOR,
        dealerId: 2,
        body: { ...claimBody, serviceOrderId: foreignOrder, claimNumber: "CLM-FIX-X" },
      });
      check("C4 claim on foreign-dealer repair order → 404", r.status === 404, `got ${r.status}`);
    }
    {
      const r = await req("GET", "/collision-claims", { user: OUTSIDER, dealerId: 2 });
      check(
        "C5 role without service view → 403",
        r.status === 403,
        `got ${r.status}`,
      );
    }
    {
      // Foreign membership: seed the same claim id lookup from a dealer-1
      // context — the outsider has no dealer-1 membership, and a dealer-1
      // claim would 404 for dealer-2 users anyway.
      const foreignClaim = await q(
        `insert into collision_claims (dealer_id, service_order_id, vehicle_info, loss_date, insurer_name, severity)
         values (1, $1, 'Foreign Collision SUV', '2026-08-15', 'Foreign Insurer', 'minor') returning id`,
        [foreignOrder],
      );
      created.claims.push(foreignClaim);
      const r = await req("GET", `/collision-claims/${foreignClaim}`, {
        user: ADVISOR,
        dealerId: 2,
      });
      check("C6 foreign claim id → 404", r.status === 404, `got ${r.status}`);
    }
    {
      // Technician boundary on evidence: a same-dealer technician who is NOT
      // assigned to the claim's repair order cannot list its documents,
      // nor read the claim itself.
      const docs = await req(
        "GET",
        `/documents?entityType=collision_claim&entityId=${claimId}`,
        { user: TECH, dealerId: 2 },
      );
      const claimRead = await req("GET", `/collision-claims/${claimId}`, {
        user: TECH,
        dealerId: 2,
      });
      const advisorDocs = await req(
        "GET",
        `/documents?entityType=collision_claim&entityId=${claimId}`,
        { user: ADVISOR, dealerId: 2 },
      );
      check(
        "C7 unassigned technician blocked from claim + evidence (404), advisor allowed",
        docs.status === 404 && claimRead.status === 404 && advisorDocs.status === 200,
        `docs ${docs.status}, claim ${claimRead.status}, advisor ${advisorDocs.status}`,
      );
    }

    console.log("\n== Workflow transitions & approvals ==");
    {
      const r = await req("POST", `/collision-claims/${claimId}/advance`, {
        user: ADVISOR,
        dealerId: 2,
        body: { targetStatus: "submitted" },
      });
      check("W1 skip-a-step intake→submitted → 422", r.status === 422, `got ${r.status}`);
    }
    {
      const blocker = await pool.connect();
      await blocker.query("begin");
      await blocker.query(
        `select id from collision_claims where id = $1 for update`,
        [claimId],
      );
      const editPromise = req("PATCH", `/collision-claims/${claimId}`, {
        user: ADVISOR,
        dealerId: 2,
        body: { initialEstimate: 510000 },
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const advancePromise = req("POST", `/collision-claims/${claimId}/advance`, {
        user: ADVISOR,
        dealerId: 2,
        body: { targetStatus: "estimate_drafted" },
      });
      await blocker.query("commit");
      blocker.release();
      const [edit, advance] = await Promise.all([editPromise, advancePromise]);
      const read = await req("GET", `/collision-claims/${claimId}`, {
        user: ADVISOR,
        dealerId: 2,
      });
      check(
        "W2 concurrent edit + advance preserve both audit events",
        edit.status === 200 &&
          advance.status === 200 &&
          read.json?.claim?.history?.some(
            (entry: { amount?: number }) => entry.amount === 510000,
          ) &&
          read.json?.claim?.history?.some(
            (entry: { to?: string }) => entry.to === "estimate_drafted",
          ),
        `edit ${edit.status}, advance ${advance.status}`,
      );
    }
    for (const target of ["submitted", "adjuster_review"]) {
      const r = await req("POST", `/collision-claims/${claimId}/advance`, {
        user: ADVISOR,
        dealerId: 2,
        body: { targetStatus: target },
      });
      check(`W2 advance → ${target}`, r.status === 200, `got ${r.status}`);
    }
    {
      const r = await req("POST", `/collision-claims/${claimId}/advance`, {
        user: ADVISOR,
        dealerId: 2,
        body: { targetStatus: "approved" },
      });
      check("W3 non-approver approve → 403", r.status === 403, `got ${r.status}`);
    }
    {
      const r = await req("POST", `/collision-claims/${claimId}/advance`, {
        user: MANAGER,
        dealerId: 2,
        body: { targetStatus: "approved" },
      });
      check(
        "W4 approve without approved estimate → 422",
        r.status === 422,
        `got ${r.status}`,
      );
    }
    {
      const r = await req("PATCH", `/collision-claims/${claimId}`, {
        user: ADVISOR,
        dealerId: 2,
        body: { contestedEstimate: 550000, approvedEstimate: 520000 },
      });
      check("W5 record contested/approved estimates", r.status === 200, `got ${r.status}`);
    }
    {
      const r = await req("POST", `/collision-claims/${claimId}/advance`, {
        user: MANAGER,
        dealerId: 2,
        body: { targetStatus: "approved" },
      });
      check("W6 manager approves → 200", r.status === 200, `got ${r.status}`);
    }
    for (const target of ["parts_ordered", "in_repair"]) {
      const r = await req("POST", `/collision-claims/${claimId}/advance`, {
        user: ADVISOR,
        dealerId: 2,
        body: { targetStatus: target },
      });
      check(`W7 advance → ${target}`, r.status === 200, `got ${r.status}`);
    }

    console.log("\n== Supplements ==");
    let suppId = 0;
    {
      const r = await req("POST", `/collision-claims/${claimId}/supplements`, {
        user: ADVISOR,
        dealerId: 2,
        body: { description: "Bent radiator support", amount: 80000 },
      });
      suppId = r.json?.id;
      check("S1 submit supplement → 201", r.status === 201 && !!suppId, `got ${r.status}`);
    }
    {
      const r = await req(
        "POST",
        `/collision-claims/${claimId}/supplements/${suppId}/decision`,
        { user: ADVISOR, dealerId: 2, body: { action: "approve" } },
      );
      check("S2 non-approver decision → 403", r.status === 403, `got ${r.status}`);
    }
    {
      const r = await req(
        "POST",
        `/collision-claims/${claimId}/supplements/${suppId}/decision`,
        { user: MANAGER, dealerId: 2, body: { action: "approve" } },
      );
      check("S3 manager approves supplement → 200", r.status === 200, `got ${r.status}`);
    }
    {
      const r = await req(
        "POST",
        `/collision-claims/${claimId}/supplements/${suppId}/decision`,
        { user: MANAGER, dealerId: 2, body: { action: "deny" } },
      );
      check("S4 re-deciding a decided supplement → 409", r.status === 409, `got ${r.status}`);
    }
    {
      const r = await req("GET", `/collision-claims/${claimId}`, {
        user: ADVISOR,
        dealerId: 2,
      });
      check(
        "S5 supplement approval leaves parent in_repair; approvedTotal = estimate + supplement",
        r.status === 200 &&
          r.json?.claim?.status === "in_repair" &&
          r.json?.approvedTotal === 600000,
        `status ${r.json?.claim?.status}, total ${r.json?.approvedTotal}`,
      );
    }

    console.log("\n== Backorder cycle-time pause ==");
    const jobCardId = await q(
      `insert into job_cards (dealer_id, service_order_id, title, status)
       values (2, $1, 'Collision fixture card', 'in_progress') returning id`,
      [orderA],
    );
    created.jobCards.push(jobCardId);
    const partId = await q(
      `insert into parts (dealer_id, sku, name, unit_cost, unit_price, stock, reorder_level)
       values (2, 'COLL-FIX-' || $1, 'Collision Fixture Bumper', 800, 1000, 0, 0) returning id`,
      [Date.now()],
    );
    created.parts.push(partId);
    {
      const r = await req("POST", `/job-cards/${jobCardId}/parts`, {
        user: ADVISOR,
        dealerId: 2,
        body: { partId, quantity: 2 },
      });
      const { rows } = await pool.query(
        `select paused_at from collision_claims where id = $1`,
        [claimId],
      );
      check(
        "B1 backordered part pauses claim cycle time",
        (r.status === 200 || r.status === 201) && rows[0]?.paused_at != null,
        `add ${r.status}, paused_at ${rows[0]?.paused_at}`,
      );
    }
    {
      const blocker = await pool.connect();
      await blocker.query("begin");
      await blocker.query(
        `select id from collision_claims where id = $1 for update`,
        [claimId],
      );
      const editPromise = req("PATCH", `/collision-claims/${claimId}`, {
        user: ADVISOR,
        dealerId: 2,
        body: { contestedEstimate: 560000 },
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const resumePromise = req("POST", `/collision-claims/${claimId}/resume`, {
        user: ADVISOR,
        dealerId: 2,
      });
      await blocker.query("commit");
      blocker.release();
      const [edit, r] = await Promise.all([editPromise, resumePromise]);
      const { rows } = await pool.query(
        `select paused_at, history from collision_claims where id = $1`,
        [claimId],
      );
      check(
        "B2 concurrent edit + resume preserve history and clear pause",
        edit.status === 200 &&
          r.status === 200 &&
          rows[0]?.paused_at == null &&
          rows[0]?.history?.some(
            (entry: { amount?: number }) => entry.amount === 560000,
          ) &&
          rows[0]?.history?.some(
            (entry: { kind?: string }) => entry.kind === "resume",
          ),
        `edit ${edit.status}, resume ${r.status}`,
      );
      // Clear the backordered line so later flows aren't affected.
      await pool.query(`delete from job_card_parts where job_card_id = $1`, [jobCardId]);
    }

    console.log("\n== Invoice gating & split settlements ==");
    {
      const blocker = await pool.connect();
      await blocker.query("begin");
      await blocker.query(
        `select id from collision_claims where id = $1 for update`,
        [claimId],
      );
      const supplementPromise = req(
        "POST",
        `/collision-claims/${claimId}/supplements`,
        {
          user: ADVISOR,
          dealerId: 2,
          body: { description: "Concurrent scope check", amount: 5000 },
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      const advancePromise = req("POST", `/collision-claims/${claimId}/advance`, {
        user: ADVISOR,
        dealerId: 2,
        body: { targetStatus: "quality_check" },
      });
      await blocker.query("commit");
      blocker.release();
      const [supplement, r] = await Promise.all([
        supplementPromise,
        advancePromise,
      ]);
      const read = await req("GET", `/collision-claims/${claimId}`, {
        user: ADVISOR,
        dealerId: 2,
      });
      check(
        "I1 concurrent supplement + advance preserve both audit events",
        supplement.status === 201 &&
          r.status === 200 &&
          read.json?.claim?.history?.some(
            (entry: { note?: string }) => entry.note === "Concurrent scope check",
          ) &&
          read.json?.claim?.history?.some(
            (entry: { to?: string }) => entry.to === "quality_check",
          ),
        `supplement ${supplement.status}, advance ${r.status}`,
      );
      await req(
        "POST",
        `/collision-claims/${claimId}/supplements/${supplement.json?.id}/decision`,
        {
          user: MANAGER,
          dealerId: 2,
          body: { action: "deny", note: "Not part of final scope" },
        },
      );
    }
    {
      const r = await req("POST", `/collision-claims/${claimId}/advance`, {
        user: MANAGER,
        dealerId: 2,
        body: { targetStatus: "insurer_signoff" },
      });
      check("I2 manager records insurer sign-off", r.status === 200, `got ${r.status}`);
    }
    {
      const r = await req("POST", `/collision-claims/${claimId}/advance`, {
        user: ADVISOR,
        dealerId: 2,
        body: { targetStatus: "invoiced" },
      });
      check("I3 invoiced without a service invoice → 422", r.status === 422, `got ${r.status}`);
    }
    // Match the UI's post-sign-off "Generate Collision Invoice" action: a
    // completed job card is invoiced through the public HTTP endpoint, which
    // atomically creates the invoice, binds the claim and stamps both splits.
    await pool.query(
      `update job_cards set status = 'completed', labor_hours = 10, labor_rate = 50000
       where id = $1 and dealer_id = 2`,
      [jobCardId],
    );
    let insurerDue = 0;
    let deductibleDue = 0;
    const issue = await req("POST", `/job-cards/${jobCardId}/invoice`, {
      user: MANAGER,
      dealerId: 2,
    });
    const invoiceId = issue.json?.id as number;
    if (invoiceId) created.invoices.push(invoiceId);
    {
      const r = await req("GET", `/collision-claims/${claimId}`, {
        user: ADVISOR,
        dealerId: 2,
      });
      insurerDue = r.json?.claim?.insurerDue ?? 0;
      deductibleDue = r.json?.claim?.deductibleDue ?? 0;
      check(
        "I4 UI invoice path creates + binds invoice and stamps split receivables",
        issue.status === 201 &&
          r.status === 200 &&
          r.json?.claim?.status === "invoiced" &&
          r.json?.claim?.serviceInvoiceId === invoiceId &&
          r.json?.claim?.deductibleDue ===
            Math.min(50000, issue.json?.total ?? 0) &&
          r.json?.claim?.insurerDue + r.json?.claim?.deductibleDue ===
            issue.json?.total,
        `issue ${issue.status}, claim ${r.status}, inv ${r.json?.claim?.serviceInvoiceId}`,
      );
      let invoiceHandoffEmails = 0;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const { rows } = await pool.query(
          `select count(*)::int as count
             from email_logs
            where dealer_id = 2
              and dedupe_key like $1`,
          [
            `collision:claim:${claimId}:status:insurer_signoff:invoiced:v1:%`,
          ],
        );
        invoiceHandoffEmails = rows[0]?.count ?? 0;
        if (invoiceHandoffEmails > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      check(
        "I4a invoice binding queues the Collision Coordinator finance handoff",
        invoiceHandoffEmails > 0,
        `emails ${invoiceHandoffEmails}`,
      );
      const discount = await req(
        "POST",
        `/service-invoices/${invoiceId}/discount`,
        {
          user: MANAGER,
          dealerId: 2,
          body: { amount: 100, reason: "Must not desynchronise split" },
        },
      );
      const adjustment = await req(
        "POST",
        `/service-invoices/${invoiceId}/adjust`,
        {
          user: MANAGER,
          dealerId: 2,
          body: { amount: -100, reason: "Must not desynchronise split" },
        },
      );
      const { rows: invoiceRows } = await pool.query(
        `select total from service_invoices where id = $1 and dealer_id = 2`,
        [invoiceId],
      );
      check(
        "I4c collision invoice discount/adjustment cannot diverge the locked split",
        discount.status === 422 &&
          adjustment.status === 422 &&
          Number(invoiceRows[0]?.total) === insurerDue + deductibleDue,
        `discount ${discount.status}, adjust ${adjustment.status}, total ${invoiceRows[0]?.total}`,
      );
      const financialEdit = await req("PATCH", `/collision-claims/${claimId}`, {
        user: MANAGER,
        dealerId: 2,
        body: { deductible: 1, approvedEstimate: 1 },
      });
      const postInvoiceSupplement = await req(
        "POST",
        `/collision-claims/${claimId}/supplements`,
        {
          user: ADVISOR,
          dealerId: 2,
          body: { description: "Too late hidden damage", amount: 1000 },
        },
      );
      const historicalPendingId = await q(
        `insert into collision_supplements
           (dealer_id, claim_id, description, amount, status, requested_by)
         values (2, $1, 'Historical pending supplement', 1000, 'pending', 'Fixture')
         returning id`,
        [claimId],
      );
      const postInvoiceApproval = await req(
        "POST",
        `/collision-claims/${claimId}/supplements/${historicalPendingId}/decision`,
        {
          user: MANAGER,
          dealerId: 2,
          body: { action: "approve", note: "Must stay locked" },
        },
      );
      const clearHistoricalPending = await req(
        "POST",
        `/collision-claims/${claimId}/supplements/${historicalPendingId}/decision`,
        {
          user: MANAGER,
          dealerId: 2,
          body: { action: "deny", note: "Denied after invoice" },
        },
      );
      check(
        "I4d post-invoice claim money and supplement approval stay locked",
        financialEdit.status === 422 &&
          postInvoiceSupplement.status === 422 &&
          postInvoiceApproval.status === 422 &&
          clearHistoricalPending.status === 200,
        `edit ${financialEdit.status}, create ${postInvoiceSupplement.status}, approve ${postInvoiceApproval.status}, deny ${clearHistoricalPending.status}`,
      );
    }
    {
      const r = await req("PATCH", `/service-invoices/${invoiceId}`, {
        user: MANAGER,
        dealerId: 2,
        body: { status: "void" },
      });
      check(
        "I4b manual void of a claim-linked invoice (no settlements yet) → 422",
        r.status === 422,
        `got ${r.status}`,
      );
    }
    {
      const r = await req("PATCH", `/service-invoices/${invoiceId}`, {
        user: MANAGER,
        dealerId: 2,
        body: { status: "paid" },
      });
      check(
        "I5 manual invoice paid before splits settle → 422",
        r.status === 422,
        `got ${r.status}`,
      );
    }
    {
      const r = await req("POST", `/collision-claims/${claimId}/settlements`, {
        user: ADVISOR,
        dealerId: 2,
        body: { payer: "insurer", amount: insurerDue + 1 },
      });
      check("P1 over-cap insurer settlement → 422", r.status === 422, `got ${r.status}`);
    }
    {
      const r1 = await req("POST", `/collision-claims/${claimId}/settlements`, {
        user: ADVISOR,
        dealerId: 2,
        body: { payer: "insurer", amount: insurerDue, reference: "EFT-FIX-1" },
      });
      const r2 = await req("POST", `/collision-claims/${claimId}/settlements`, {
        user: ADVISOR,
        dealerId: 2,
        body: { payer: "insurer", amount: 1, reference: "EFT-FIX-1" },
      });
      check(
        "P2 insurer settlement ok; duplicate reference replays not double-collect",
        r1.status === 201 && (r2.status === 200 || r2.status === 201 || r2.status === 409 || r2.status === 422),
        `got ${r1.status}/${r2.status}`,
      );
      const { rows } = await pool.query(
        `select coalesce(sum(amount),0) s from collision_settlements where claim_id = $1 and payer = 'insurer'`,
        [claimId],
      );
      check(
        "P3 insurer collected never exceeds insurer due",
        Number(rows[0].s) <= insurerDue,
        `sum ${rows[0].s}`,
      );
    }
    {
      const rVoid = await req("PATCH", `/service-invoices/${invoiceId}`, {
        user: MANAGER,
        dealerId: 2,
        body: { status: "void" },
      });
      check(
        "P4 void after settlements recorded → 422",
        rVoid.status === 422,
        `got ${rVoid.status}`,
      );
      // Force-void via SQL to prove the settlement path itself refuses to
      // collect against a dead invoice, then restore.
      await pool.query(`update service_invoices set status = 'void' where id = $1`, [invoiceId]);
      const rDead = await req("POST", `/collision-claims/${claimId}/settlements`, {
        user: ADVISOR,
        dealerId: 2,
        body: { payer: "customer", amount: 1 },
      });
      check("P4b settlements refused against a void invoice → 422", rDead.status === 422, `got ${rDead.status}`);
      await pool.query(`update service_invoices set status = 'issued' where id = $1`, [invoiceId]);
    }
    {
      const r = await req("POST", `/collision-claims/${claimId}/advance`, {
        user: ADVISOR,
        dealerId: 2,
        body: { targetStatus: "closed" },
      });
      check(
        "P5 close with deductible outstanding → 422",
        r.status === 422,
        `got ${r.status}`,
      );
    }
    {
      const r = await req("POST", `/collision-claims/${claimId}/settlements`, {
        user: ADVISOR,
        dealerId: 2,
        body: { payer: "customer", amount: deductibleDue, method: "cash" },
      });
      check("P6 customer deductible collected", r.status === 201, `got ${r.status}`);
      const { rows } = await pool.query(
        `select status from service_invoices where id = $1`,
        [invoiceId],
      );
      check(
        "P7 invoice auto-flips to paid once both shares settle",
        rows[0]?.status === "paid",
        `status ${rows[0]?.status}`,
      );
    }
    {
      const r = await req("POST", `/collision-claims/${claimId}/advance`, {
        user: ADVISOR,
        dealerId: 2,
        body: { targetStatus: "closed" },
      });
      const detail = await req("GET", `/collision-claims/${claimId}`, {
        user: ADVISOR,
        dealerId: 2,
      });
      const history = detail.json?.claim?.history ?? [];
      check(
        "P8 full journey closes; append-only history has created/status/supplement/pause/payment events",
        r.status === 200 &&
          detail.json?.claim?.status === "closed" &&
          ["created", "status", "supplement", "pause", "payment"].every((k) =>
            history.some((e: any) => e.kind === k),
          ),
        `close ${r.status}, kinds ${[...new Set(history.map((e: any) => e.kind))].join(",")}`,
      );
    }

    console.log("\n== Denied / total-loss exits ==");
    {
      const r = await req("POST", "/collision-claims", {
        user: ADVISOR,
        dealerId: 2,
        body: {
          serviceOrderId: orderB,
          lossDate: "2026-08-16",
          insurerName: "GTM Fixture",
          severity: "severe",
          initialEstimate: 900000,
        },
      });
      const denyClaim = r.json?.id as number;
      created.claims.push(denyClaim);
      for (const target of ["estimate_drafted", "submitted"]) {
        await req("POST", `/collision-claims/${denyClaim}/advance`, {
          user: ADVISOR,
          dealerId: 2,
          body: { targetStatus: target },
        });
      }
      const deny = await req("POST", `/collision-claims/${denyClaim}/advance`, {
        user: MANAGER,
        dealerId: 2,
        body: { targetStatus: "denied", note: "Policy lapsed" },
      });
      const after = await req("POST", `/collision-claims/${denyClaim}/advance`, {
        user: MANAGER,
        dealerId: 2,
        body: { targetStatus: "adjuster_review" },
      });
      check(
        "D1 denied from submitted is terminal",
        deny.status === 200 && deny.json?.status === "denied" && after.status === 422,
        `deny ${deny.status}, after ${after.status}`,
      );
    }
    {
      const r = await req("POST", "/collision-claims", {
        user: ADVISOR,
        dealerId: 2,
        body: {
          serviceOrderId: orderC,
          lossDate: "2026-08-17",
          insurerName: "Hand-in-Hand Fixture",
          severity: "severe",
          initialEstimate: 3000000,
        },
      });
      const tlClaim = r.json?.id as number;
      created.claims.push(tlClaim);
      for (const target of ["estimate_drafted", "submitted", "adjuster_review"]) {
        await req("POST", `/collision-claims/${tlClaim}/advance`, {
          user: ADVISOR,
          dealerId: 2,
          body: { targetStatus: target },
        });
      }
      const noValue = await req("POST", `/collision-claims/${tlClaim}/advance`, {
        user: MANAGER,
        dealerId: 2,
        body: { targetStatus: "total_loss" },
      });
      const withValue = await req("POST", `/collision-claims/${tlClaim}/advance`, {
        user: MANAGER,
        dealerId: 2,
        body: { targetStatus: "total_loss", totalLossValue: 2500000 },
      });
      check(
        "D2 total loss requires vehicle value evidence, then closes terminal",
        noValue.status === 422 && withValue.status === 200 && withValue.json?.status === "total_loss",
        `noValue ${noValue.status}, withValue ${withValue.status}`,
      );
      const settle = await req("POST", `/collision-claims/${tlClaim}/settlements`, {
        user: ADVISOR,
        dealerId: 2,
        body: { payer: "insurer", amount: 1000 },
      });
      check("D3 no collections on a total-loss claim → 422", settle.status === 422, `got ${settle.status}`);
    }

    console.log("\n== Concurrent invoice issuance ==");
    {
      const orderD = await q(
        `insert into service_orders (dealer_id, vehicle_info, type, scheduled_date)
         values (2, 'Collision Fixture Land Cruiser', 'repair', '2026-08-23') returning id`,
      );
      created.orders.push(orderD);
      const r = await req("POST", "/collision-claims", {
        user: ADVISOR,
        dealerId: 2,
        body: {
          serviceOrderId: orderD,
          lossDate: "2026-08-18",
          insurerName: "Diamond Fixture",
          severity: "moderate",
          initialEstimate: 200000,
          deductible: 20000,
        },
      });
      const raceClaim = r.json?.id as number;
      created.claims.push(raceClaim);
      for (const t of ["estimate_drafted", "submitted", "adjuster_review"]) {
        await req("POST", `/collision-claims/${raceClaim}/advance`, {
          user: ADVISOR, dealerId: 2, body: { targetStatus: t },
        });
      }
      await req("PATCH", `/collision-claims/${raceClaim}`, {
        user: ADVISOR, dealerId: 2, body: { approvedEstimate: 200000 },
      });
      await req("POST", `/collision-claims/${raceClaim}/advance`, {
        user: MANAGER, dealerId: 2, body: { targetStatus: "approved" },
      });
      for (const t of ["parts_ordered", "in_repair", "quality_check"]) {
        await req("POST", `/collision-claims/${raceClaim}/advance`, {
          user: ADVISOR, dealerId: 2, body: { targetStatus: t },
        });
      }
      await req("POST", `/collision-claims/${raceClaim}/advance`, {
        user: MANAGER, dealerId: 2, body: { targetStatus: "insurer_signoff" },
      });
      const raceCard = await q(
        `insert into job_cards (dealer_id, service_order_id, title, status)
         values (2, $1, 'Collision race card', 'completed') returning id`,
        [orderD],
      );
      created.jobCards.push(raceCard);
      // Queue invoice issuance first behind an explicit row lock, then queue a
      // financial edit and supplement submission that both observed the old,
      // unbound claim. Once released, the shared FOR UPDATE serialization must
      // let issuance bind first and force both stale mutations to re-check.
      const blocker = await pool.connect();
      await blocker.query("begin");
      await blocker.query(
        `select id from collision_claims where id = $1 for update`,
        [raceClaim],
      );
      const aPromise = req("POST", `/job-cards/${raceCard}/invoice`, {
        user: MANAGER,
        dealerId: 2,
      });
      const bPromise = req("POST", `/job-cards/${raceCard}/invoice`, {
        user: MANAGER,
        dealerId: 2,
      });
      await new Promise((resolve) => setTimeout(resolve, 75));
      const editPromise = req("PATCH", `/collision-claims/${raceClaim}`, {
        user: MANAGER,
        dealerId: 2,
        body: { deductible: 1 },
      });
      const supplementPromise = req(
        "POST",
        `/collision-claims/${raceClaim}/supplements`,
        {
          user: ADVISOR,
          dealerId: 2,
          body: { description: "Concurrent hidden damage", amount: 5000 },
        },
      );
      await blocker.query("commit");
      blocker.release();
      const [a, b, racedEdit, racedSupplement] = await Promise.all([
        aPromise,
        bPromise,
        editPromise,
        supplementPromise,
      ]);
      const statuses = [a.status, b.status].sort();
      const { rows: invRows } = await pool.query(
        `select id from service_invoices where job_card_id = $1`,
        [raceCard],
      );
      for (const row of invRows) created.invoices.push(row.id);
      const { rows: claimRows } = await pool.query(
        `select status, service_invoice_id, deductible, history from collision_claims where id = $1`,
        [raceClaim],
      );
      const { rows: racedSupplements } = await pool.query(
        `select id from collision_supplements where claim_id = $1`,
        [raceClaim],
      );
      check(
        "X1 concurrent issue: one 201 + one 409, single invoice row",
        statuses[0] === 201 && statuses[1] === 409 && invRows.length === 1,
        `statuses ${statuses.join("/")}, invoices ${invRows.length}`,
      );
      check(
        "X2 the surviving invoice is the claim-bound one and claim is invoiced",
        claimRows[0]?.status === "invoiced" &&
          claimRows[0]?.service_invoice_id === invRows[0]?.id,
        `claim ${claimRows[0]?.status}, bound ${claimRows[0]?.service_invoice_id}, invoice ${invRows[0]?.id}`,
      );
      check(
        "X3 invoice race rejects stale financial/supplement writes without losing history",
        racedEdit.status === 422 &&
          racedSupplement.status === 422 &&
          Number(claimRows[0]?.deductible) === 20000 &&
          racedSupplements.length === 0 &&
          Array.isArray(claimRows[0]?.history) &&
          claimRows[0].history.some(
            (entry: { to?: string }) => entry.to === "invoiced",
          ),
        `edit ${racedEdit.status}, supplement ${racedSupplement.status}, deductible ${claimRows[0]?.deductible}, supplements ${racedSupplements.length}`,
      );
    }

    console.log("\n== Reporting & repair-order close guard ==");
    {
      const r = await req("GET", "/reports?type=collision_claims", {
        user: MANAGER,
        dealerId: 2,
      });
      check(
        "R1 collision report renders for a manager",
        r.status === 200 && r.json?.type === "collision_claims",
        `got ${r.status}`,
      );
      const r2 = await req("GET", "/reports?type=collision_claims", {
        user: ADVISOR,
        dealerId: 2,
      });
      check("R2 advisor tier blocked from collision report → 403", r2.status === 403, `got ${r2.status}`);
    }
  } finally {
    // Cleanup — reverse dependency order; claims cascade supplements/settlements.
    for (const id of created.claims) {
      await pool.query(
        `delete from email_logs where dealer_id = 2 and dedupe_key like $1`,
        [`collision:claim:${id}:%`],
      ).catch(() => {});
      await pool.query(
        `delete from notifications where dealer_id = 2 and entity_type = 'collision_claim' and entity_id = $1`,
        [id],
      ).catch(() => {});
      await pool.query(
        `delete from agent_runs where dealer_id = 2 and ref_type = 'collision_claim' and ref_id = $1`,
        [id],
      ).catch(() => {});
      await pool.query(`delete from collision_claims where id = $1`, [id]).catch(() => {});
    }
    for (const id of created.invoices)
      await pool.query(`delete from service_invoices where id = $1`, [id]).catch(() => {});
    for (const id of created.jobCards) {
      await pool.query(`delete from job_card_parts where job_card_id = $1`, [id]).catch(() => {});
      await pool.query(`delete from job_cards where id = $1`, [id]).catch(() => {});
    }
    for (const id of created.parts)
      await pool.query(`delete from parts where id = $1`, [id]).catch(() => {});
    for (const id of created.orders)
      await pool.query(`delete from service_orders where id = $1`, [id]).catch(() => {});
    for (const email of [MANAGER, ADVISOR, OUTSIDER, TECH])
      await pool.query(`delete from users where lower(email) = $1`, [email]).catch(() => {});
    await pool.query(
      `select pg_advisory_unlock(hashtext('aura-verify-collision-claims-v1'))`,
    );
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log("Failures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exitCode = fail > 0 ? 1 : 0;
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
