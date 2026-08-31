import { eq, inArray } from "drizzle-orm";
import {
  db,
  pool,
  usersTable,
  dealerUsersTable,
  rolesTable,
  serviceOrdersTable,
  jobCardsTable,
  serviceInvoicesTable,
} from "@workspace/db";

// Targeted regression suite for Task 187 governance controls (run against the
// DEV api-server; uses the dev-only x-test-user-email persona header):
//   1. Invoice adjustments are approver-only (service:create is NOT enough)
//   2. Paid invoices cannot be adjusted (credit-note path only)
//   3. Adjustments are conditional — a stale total loses with 409
//   4. Rollover manager sign-off is approver-only; technician sign-off is
//      assigned-technician-only
//   5. Sign-offs are immutable: a second same-capacity sign-off gets 409 and
//      cannot overwrite who/when; the second distinct signature approves and
//      moves scheduledAt to the carry-over date
//
// Fixtures are ephemeral single-dealer test users (never shared demo
// accounts) plus throwaway service rows, all deleted in the finally block.

const BASE = process.env.API_BASE ?? "http://localhost:80/api";
const DEALER = 1;
const MGR = "svcwf-test-mgr@aura-test.local";
const TECH = "svcwf-test-tech@aura-test.local";
const ADVISOR = "svcwf-test-advisor@aura-test.local";

function futureDate(daysFromToday: number): string {
  const date = new Date();
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + daysFromToday);
  return date.toISOString().slice(0, 10);
}

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
  body?: unknown,
) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "x-test-user-email": user,
      "x-dealer-id": String(DEALER),
      "content-type": "application/json",
    },
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

async function ensureUser(email: string, name: string, roleName: string) {
  const [role] = await db
    .select()
    .from(rolesTable)
    .where(eq(rolesTable.name, roleName));
  if (!role) throw new Error(`role not found: ${roleName}`);
  const [user] = await db
    .insert(usersTable)
    .values({ clerkId: `test_${email}`, email, name, roleId: role.id })
    .returning();
  await db.insert(dealerUsersTable).values({
    dealerId: DEALER,
    userId: user.id,
    roleId: role.id,
  });
  return user;
}

async function main() {
  const cleanupEmails = [MGR, TECH, ADVISOR];
  const scheduledDate = futureDate(1);
  const firstRolloverDate = futureDate(2);
  const partialRolloverDate = futureDate(3);
  const reRequestDate = futureDate(10);
  let orderId: number | null = null;
  try {
    // ---- fixtures -----------------------------------------------------
    const mgr = await ensureUser(MGR, "SvcWF Test Manager", "Service Manager");
    const tech = await ensureUser(TECH, "SvcWF Test Tech", "Technician");
    await ensureUser(ADVISOR, "SvcWF Test Advisor", "Service Advisor");
    void mgr;

    const [order] = await db
      .insert(serviceOrdersTable)
      .values({
        dealerId: DEALER,
        vehicleInfo: "SVCWF Test Vehicle",
        scheduledDate,
        status: "in_progress",
      })
      .returning();
    orderId = order.id;

    const [card] = await db
      .insert(jobCardsTable)
      .values({
        dealerId: DEALER,
        serviceOrderId: order.id,
        title: "SVCWF rollover test job",
        status: "in_progress",
        technicianUserId: tech.id,
        technicianName: "SvcWF Test Tech",
        scheduledAt: new Date(`${scheduledDate}T09:30:00Z`),
        rolloverStatus: "pending",
        rolloverToDate: firstRolloverDate,
        rolloverRequestedBy: "SvcWF Test Manager",
        rolloverRequestedAt: new Date(),
      })
      .returning();

    const [issued] = await db
      .insert(serviceInvoicesTable)
      .values({
        dealerId: DEALER,
        serviceOrderId: order.id,
        jobCardId: card.id,
        vehicleInfo: "SVCWF Test Vehicle",
        partsTotal: 100,
        laborTotal: 200,
        total: 300,
        status: "issued",
        lockedAt: new Date(),
      })
      .returning();
    // Separate job card for the paid invoice: service_invoices enforces one
    // invoice per job card (collision-claims invariant).
    const [paidCard] = await db
      .insert(jobCardsTable)
      .values({
        dealerId: DEALER,
        serviceOrderId: order.id,
        title: "SVCWF paid-invoice job",
        status: "completed",
        technicianUserId: tech.id,
        technicianName: "SvcWF Test Tech",
      })
      .returning();
    const [paid] = await db
      .insert(serviceInvoicesTable)
      .values({
        dealerId: DEALER,
        serviceOrderId: order.id,
        jobCardId: paidCard.id,
        vehicleInfo: "SVCWF Test Vehicle",
        partsTotal: 50,
        laborTotal: 50,
        total: 100,
        status: "paid",
        lockedAt: new Date(),
      })
      .returning();

    // ---- 1. adjustment authorization ---------------------------------
    console.log("1. Invoice adjustment authorization");
    const r1 = await call("POST", `/service-invoices/${issued.id}/adjust`, ADVISOR, {
      amount: -50,
      reason: "advisor should be blocked",
    });
    check("service advisor adjust → 403", r1.status === 403, `got ${r1.status}`);

    const r2 = await call("POST", `/service-invoices/${paid.id}/adjust`, MGR, {
      amount: -10,
      reason: "paid invoice must be immutable",
    });
    check("manager adjust on PAID invoice → 422", r2.status === 422, `got ${r2.status}`);

    const r3 = await call("POST", `/service-invoices/${issued.id}/adjust`, MGR, {
      amount: -50,
      reason: "goodwill credit",
    });
    check(
      "manager adjust on issued invoice → 200, total 250, trail entry",
      r3.status === 200 &&
        r3.json?.total === 250 &&
        (r3.json?.adjustments ?? []).length === 1,
      `got ${r3.status} total=${r3.json?.total}`,
    );

    // Compare-and-set: concurrent adjustments must never lose an update.
    // Either the loser gets a 409, or the requests serialized and BOTH landed
    // — in which case the total and audit trail must reflect both entries.
    const [ca, cb] = await Promise.all([
      call("POST", `/service-invoices/${issued.id}/adjust`, MGR, {
        amount: -25,
        reason: "concurrent A",
      }),
      call("POST", `/service-invoices/${issued.id}/adjust`, MGR, {
        amount: -25,
        reason: "concurrent B",
      }),
    ]);
    const wins = [ca, cb].filter((r) => r.status === 200).length;
    const rejects = [ca, cb].filter((r) => r.status === 409).length;
    const [afterConcurrent] = await db
      .select()
      .from(serviceInvoicesTable)
      .where(eq(serviceInvoicesTable.id, issued.id));
    const expectedTotal = 250 - 25 * wins;
    check(
      "concurrent adjustments → no lost update (total + trail consistent)",
      wins >= 1 &&
        wins + rejects === 2 &&
        afterConcurrent.total === expectedTotal &&
        (afterConcurrent.adjustments ?? []).length === 1 + wins,
      `statuses=${ca.status},${cb.status} total=${afterConcurrent.total} entries=${(afterConcurrent.adjustments ?? []).length}`,
    );

    // ---- 2. rollover sign-off authorization --------------------------
    console.log("2. Rollover dual sign-off");
    const r4 = await call("POST", `/job-cards/${card.id}/rollover/approve`, ADVISOR, {
      as: "manager",
    });
    check("advisor sign-off as manager → 403", r4.status === 403, `got ${r4.status}`);

    const r5 = await call("POST", `/job-cards/${card.id}/rollover/approve`, MGR, {
      as: "technician",
    });
    check("manager sign-off as technician → 403", r5.status === 403, `got ${r5.status}`);

    const r6 = await call("POST", `/job-cards/${card.id}/rollover/approve`, MGR, {
      as: "manager",
    });
    check(
      "manager sign-off → 200, recorded who/when, still pending",
      r6.status === 200 &&
        r6.json?.rolloverManagerApprovedBy === "SvcWF Test Manager" &&
        r6.json?.rolloverStatus === "pending",
      `got ${r6.status} status=${r6.json?.rolloverStatus}`,
    );
    const firstSignedAt = r6.json?.rolloverManagerApprovedAt;

    const r7 = await call("POST", `/job-cards/${card.id}/rollover/approve`, MGR, {
      as: "manager",
    });
    check("duplicate manager sign-off → 409", r7.status === 409, `got ${r7.status}`);
    const [afterDup] = await db
      .select()
      .from(jobCardsTable)
      .where(eq(jobCardsTable.id, card.id));
    check(
      "duplicate did NOT overwrite the recorded sign-off",
      afterDup.rolloverManagerApprovedAt?.toISOString() === firstSignedAt,
      `db=${afterDup.rolloverManagerApprovedAt?.toISOString()} first=${firstSignedAt}`,
    );

    // Concurrent technician sign-offs: exactly one lands, card approves once.
    const [t1, t2] = await Promise.all([
      call("POST", `/job-cards/${card.id}/rollover/approve`, TECH, { as: "technician" }),
      call("POST", `/job-cards/${card.id}/rollover/approve`, TECH, { as: "technician" }),
    ]);
    // The loser is rejected either by the conditional UPDATE (409) or by the
    // pre-route pending check when serialized (422) — never a second 200.
    const tOutcomes = [t1.status, t2.status].sort();
    check(
      "concurrent tech sign-offs → exactly one wins (200 + 409/422)",
      tOutcomes[0] === 200 && (tOutcomes[1] === 409 || tOutcomes[1] === 422),
      `got ${tOutcomes.join(",")}`,
    );
    const [final] = await db
      .select()
      .from(jobCardsTable)
      .where(eq(jobCardsTable.id, card.id));
    check(
      "second signature approved the rollover and moved the schedule",
      final.rolloverStatus === "approved" &&
        final.scheduledAt != null &&
        final.scheduledAt.toISOString().startsWith(firstRolloverDate),
      `status=${final.rolloverStatus} scheduledAt=${final.scheduledAt?.toISOString()}`,
    );

    // ---- 3. sign-off evidence cannot be destroyed by a re-request -----
    console.log("3. Rollover re-request guards");
    // Reset the fixture to a fresh pending rollover with one signature.
    await db
      .update(jobCardsTable)
      .set({
        rolloverStatus: "pending",
        rolloverToDate: partialRolloverDate,
        rolloverManagerApprovedBy: "SvcWF Test Manager",
        rolloverManagerApprovedAt: new Date(),
        rolloverTechApprovedBy: null,
        rolloverTechApprovedAt: null,
      })
      .where(eq(jobCardsTable.id, card.id));
    const rr1 = await call("POST", `/job-cards/${card.id}/rollover`, ADVISOR, {
      toDate: reRequestDate,
      reason: "attempted overwrite",
    });
    const [afterRr1] = await db
      .select()
      .from(jobCardsTable)
      .where(eq(jobCardsTable.id, card.id));
    check(
      "re-request while pending (partial sign-off) → 422, signature intact",
      rr1.status === 422 &&
        rr1.json?.error?.includes("already awaiting sign-off") &&
        afterRr1.rolloverManagerApprovedBy === "SvcWF Test Manager" &&
        afterRr1.rolloverToDate === partialRolloverDate,
      `got ${rr1.status} mgr=${afterRr1.rolloverManagerApprovedBy} to=${afterRr1.rolloverToDate}`,
    );

    // Fully approve, then re-request: allowed, but the executed approval must
    // be archived as an append-only audit line, not silently destroyed.
    await db
      .update(jobCardsTable)
      .set({
        rolloverStatus: "approved",
        rolloverTechApprovedBy: "SvcWF Test Tech",
        rolloverTechApprovedAt: new Date(),
      })
      .where(eq(jobCardsTable.id, card.id));
    const rr2 = await call("POST", `/job-cards/${card.id}/rollover`, ADVISOR, {
      toDate: reRequestDate,
      reason: "second carry-over",
    });
    const [afterRr2] = await db
      .select()
      .from(jobCardsTable)
      .where(eq(jobCardsTable.id, card.id));
    check(
      "re-request after approval → 200 with prior approval archived in notes",
      rr2.status === 200 &&
        afterRr2.rolloverStatus === "pending" &&
        (afterRr2.notes ?? "").includes("[Rollover audit]") &&
        (afterRr2.notes ?? "").includes("SvcWF Test Manager"),
      `got ${rr2.status} notes=${(afterRr2.notes ?? "").slice(0, 80)}`,
    );

    // ---- 4. paid invoices cannot be reopened via PATCH ----------------
    console.log("4. Invoice lifecycle is irreversible");
    const p1 = await call("PATCH", `/service-invoices/${paid.id}`, MGR, {
      status: "issued",
    });
    check("PATCH paid → issued rejected (422)", p1.status === 422, `got ${p1.status}`);
    const p2 = await call("PATCH", `/service-invoices/${paid.id}`, MGR, {
      status: "void",
    });
    check("PATCH paid → void rejected (422)", p2.status === 422, `got ${p2.status}`);
    const p3 = await call("PATCH", `/service-invoices/${paid.id}`, MGR, {
      signedCopyFiled: true,
    });
    check(
      "non-financial acknowledgement on paid invoice still allowed",
      p3.status === 200 && p3.json?.signedCopyFiledAt != null,
      `got ${p3.status}`,
    );
    const [paidAfter] = await db
      .select()
      .from(serviceInvoicesTable)
      .where(eq(serviceInvoicesTable.id, paid.id));
    check(
      "paid invoice still paid and unadjustable",
      paidAfter.status === "paid" && paidAfter.total === 100,
      `status=${paidAfter.status} total=${paidAfter.total}`,
    );
  } finally {
    // ---- cleanup ------------------------------------------------------
    if (orderId != null) {
      await db
        .delete(serviceInvoicesTable)
        .where(eq(serviceInvoicesTable.serviceOrderId, orderId));
      await db
        .delete(jobCardsTable)
        .where(eq(jobCardsTable.serviceOrderId, orderId));
      await db.delete(serviceOrdersTable).where(eq(serviceOrdersTable.id, orderId));
    }
    const users = await db
      .select()
      .from(usersTable)
      .where(inArray(usersTable.email, cleanupEmails));
    if (users.length) {
      await db.delete(usersTable).where(
        inArray(
          usersTable.id,
          users.map((u) => u.id),
        ),
      );
    }
    await pool.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(failures.map((f) => `  - ${f}`).join("\n"));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
