/**
 * Service-level tests for operational sales finance requests (dev DB only,
 * isolated fixture dealers, fake ERPNext remote — no external posting).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertDevelopmentDatabase } from "./dev-db-guard";
const target = await assertDevelopmentDatabase();
console.log(`dev DB verified: ${target.database}@${target.host}`);
const {
  db, dealersTable, usersTable, vehiclesTable, dealsTable, invoicesTable, paymentsTable, receiptsTable, erpnextRefsTable, erpnextSyncJobsTable,
  auditLogsTable, salesAccountingSettingsTable, salesAccountingWorkflowsTable, salesFinanceRequestsTable,
} = await import("@workspace/db");
const { eq, inArray, and } = await import("drizzle-orm");
const svc = await import("../lib/sales-finance-requests");

const nonce = randomUUID().slice(0, 8);
const dealerIds: number[] = []; const userIds: number[] = [];
const remoteCalls: string[] = [];
let failNext = false;
let nullNext = false;
let journalMode: "ok" | "slow" | "fail" = "ok";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const remote: import("../lib/sales-finance-requests").SalesFinanceRemote = {
  async postInvoice(job, invoiceId) {
    if (failNext) { failNext = false; throw new Error("ERPNext 417: account not found"); }
    if (nullNext) { nullNext = false; return null; }
    const [ex] = await db.select().from(erpnextRefsTable).where(and(eq(erpnextRefsTable.dealerId, job.dealerId), eq(erpnextRefsTable.entityType, "invoice"), eq(erpnextRefsTable.entityId, invoiceId)));
    if (ex) return ex.docName;
    remoteCalls.push(`SI:${invoiceId}`);
    await db.insert(erpnextRefsTable).values({ dealerId: job.dealerId, entityType: "invoice", entityId: invoiceId, doctype: "Sales Invoice", docName: `SINV-${invoiceId}` });
    return `SINV-${invoiceId}`;
  },
  async postPayment(_job, paymentId) { remoteCalls.push(`PE:${paymentId}`); return `PE-${paymentId}`; },
  async postJournal(_d, id) {
    const mode = journalMode;
    if (mode === "fail") { await sleep(150); throw new Error("ERPNext timeout (late duplicate worker)"); }
    if (mode === "slow") await sleep(20);
    remoteCalls.push(`JE:${id}`); return `JE-${id}`;
  },
};
async function runJob(requestId: number) {
  const [r] = await db.select().from(salesFinanceRequestsTable).where(eq(salesFinanceRequestsTable.id, requestId));
  const [job] = await db.select().from(erpnextSyncJobsTable).where(eq(erpnextSyncJobsTable.id, r!.erpJobId!));
  return svc.executeRequestPosting(job!, remote);
}
async function expectStatus(p: Promise<unknown>, status: number, re?: RegExp) {
  try { await p; } catch (e) { assert.equal((e as { status?: number }).status, status, String(e)); if (re) assert.match(String(e), re); return; }
  assert.fail(`expected ${status}`);
}
try {
  const mk = async (name: string) => { const [u] = await db.insert(usersTable).values({ clerkId: `sfr-${name}-${nonce}`, email: `sfr-${name}-${nonce}@example.invalid`, name }).returning(); userIds.push(u!.id); return u!; };
  const requester = await mk("Requester"), approver = await mk("Approver");
  const A = (u: { id: number; name: string | null }, approve = true) => ({ id: u.id, name: u.name ?? "", canEdit: true, canApprove: approve });
  const setup = async (label: string) => {
    const [dealer] = await db.insert(dealersTable).values({ name: `CAM Motors Dummy (dev fixture ${label} ${nonce})`, status: "provisioning" }).returning();
    dealerIds.push(dealer!.id);
    const [v] = await db.insert(vehiclesTable).values({ dealerId: dealer!.id, make: "BYD", model: "Atto", year: 2026, price: 1140, powertrain: "ev", mileageKm: 0, exteriorColor: "White", bodyType: "SUV", vin: `SFR${nonce}${label}` }).returning();
    const [deal] = await db.insert(dealsTable).values({ dealerId: dealer!.id, vehicleId: v!.id, customerName: "SFR Test", vehiclePrice: 1000, otdPrice: 1140, stage: "committed" }).returning();
    await db.insert(salesAccountingWorkflowsTable).values({ dealerId: dealer!.id, dealId: deal!.id, startedBy: requester.id });
    await db.insert(salesAccountingSettingsTable).values({ dealerId: dealer!.id, updatedBy: requester.id, revision: 1, validation: { state: "valid", errors: [] }, config: {
      accounts: ["receivables", "vatOutput", "registration", "fuel", "detailing"].map((k) => ({ key: k, account: k.toUpperCase() })),
      sources: [{ id: "bank", label: "Bank", kind: "bank", account: "BANK" }, { id: "float", label: "Float", kind: "float", account: "FLOAT" }],
      models: [{ make: "BYD", model: "Atto", income: "SALES", dutyFreeIncome: "", inventory: "S", cogs: "C", discount: "D" }],
      customerCharges: [{ category: "fuel", incomeAccount: "FUEL-REC", taxTreatment: "taxable", vatRate: 14, amountIncludesVat: true, approved: true, approvalReference: "FIN" }] } });
    const [inv] = await db.insert(invoicesTable).values({ dealerId: dealer!.id, invoiceNumber: `T-${nonce}-${label}`, customerName: "SFR Test", dealId: deal!.id, kind: "final", status: "issued", amount: 1140,
      taxLines: [{ code: "VAT", name: "VAT", kind: "percent", rate: 14, amount: 140 }] }).returning();
    const [res] = await db.insert(invoicesTable).values({ dealerId: dealer!.id, invoiceNumber: `R-${nonce}-${label}`, customerName: "SFR Test", dealId: deal!.id, kind: "reservation", status: "issued", amount: 50 }).returning();
    return { dealerId: dealer!.id, dealId: deal!.id, invoiceId: inv!.id, reservationId: res!.id };
  };
  const f = await setup("a"), other = await setup("b");
  const today = "2026-10-16";

  // Requester cannot approve own; rejection has no financial effect.
  const rej = await svc.createRequest(f.dealerId, f.dealId, A(requester), { kind: "expense", date: today, amount: "25.00", category: "registration", sourceId: "bank", billingTreatment: "dealer_paid", reference: "REG-1" });
  assert.equal(rej.status, "pending");
  await expectStatus(svc.decideRequest(f.dealerId, rej.id, A(requester), "approve"), 403, /different Finance approver/);
  await expectStatus(svc.decideRequest(f.dealerId, rej.id, A(approver, false), "approve"), 403);
  await expectStatus(svc.decideRequest(f.dealerId, rej.id, A(approver), "reject"), 400);
  const rejected = await svc.decideRequest(f.dealerId, rej.id, A(approver), "reject", "No receipt attached");
  assert.equal(rejected.status, "rejected"); assert.equal(rejected.erpJobId, null);
  await expectStatus(svc.decideRequest(f.dealerId, rej.id, A(approver), "approve"), 409);
  console.log("ok rejection: no job, no remote, terminal");

  // Tenant isolation: other dealer cannot see/decide.
  await expectStatus(svc.decideRequest(other.dealerId, rej.id, A(approver), "approve"), 404);
  await expectStatus(svc.createRequest(other.dealerId, f.dealId, A(requester), { kind: "invoice", date: today, amount: "1140", invoiceId: f.invoiceId, reference: "x" }), 404);
  await expectStatus(svc.createRequest(f.dealerId, f.dealId, A(requester), { kind: "invoice", date: today, amount: "1140", invoiceId: other.invoiceId, reference: "x" }), 404);
  console.log("ok tenant isolation");

  // Pending VAT: reservation invoice and deposit payment are blocked, never approvable.
  const vat = await svc.createRequest(f.dealerId, f.dealId, A(requester), { kind: "payment", date: today, amount: "50", invoiceId: f.reservationId, sourceId: "bank", paymentMethod: "cash", payerType: "customer", reference: "DEP-1" });
  assert.equal(vat.status, "blocked"); assert.ok(vat.blockers.some((b) => b.includes("Advance VAT")));
  await expectStatus(svc.decideRequest(f.dealerId, vat.id, A(approver), "approve"), 409);
  console.log("ok pending advance VAT blocked");

  // Payment before invoice posted is not approvable; payment submission does not pay the invoice.
  const early = await svc.createRequest(f.dealerId, f.dealId, A(requester), { kind: "payment", date: today, amount: "600", invoiceId: f.invoiceId, sourceId: "bank", paymentMethod: "bank_transfer", payerType: "customer", reference: "BT-1" });
  await expectStatus(svc.decideRequest(f.dealerId, early.id, A(approver), "approve"), 422, /Post the invoice/);
  const [stillIssued] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, f.invoiceId));
  assert.equal(stillIssued!.status, "issued");
  console.log("ok submission does not mark paid");

  // Invoice request: approve -> job; fail -> failed; retry -> posted; duplicate approval refused.
  const invReq = await svc.createRequest(f.dealerId, f.dealId, A(requester), { kind: "invoice", date: today, amount: "1140.00", invoiceId: f.invoiceId, reference: "INV-1" });
  await expectStatus(svc.createRequest(f.dealerId, f.dealId, A(requester), { kind: "invoice", date: today, amount: "1140.00", invoiceId: f.invoiceId, reference: "INV-1b" }), 409);
  const approved = await svc.decideRequest(f.dealerId, invReq.id, A(approver), "approve");
  assert.equal(approved.status, "approved");
  await expectStatus(svc.decideRequest(f.dealerId, invReq.id, A(approver), "approve"), 409);
  failNext = true;
  await assert.rejects(runJob(invReq.id));
  const [failed] = await db.select().from(salesFinanceRequestsTable).where(eq(salesFinanceRequestsTable.id, invReq.id));
  assert.equal(failed!.status, "failed"); assert.match(failed!.lastError!, /account not found/);
  await svc.retryRequest(f.dealerId, invReq.id, A(approver));
  await expectStatus(svc.retryRequest(f.dealerId, invReq.id, A(approver)), 409);
  await runJob(invReq.id);
  await runJob(invReq.id); // duplicate delivery is idempotent
  const [posted] = await db.select().from(salesFinanceRequestsTable).where(eq(salesFinanceRequestsTable.id, invReq.id));
  assert.equal(posted!.status, "posted"); assert.equal(remoteCalls.filter((c) => c === `SI:${f.invoiceId}`).length, 1);
  console.log("ok invoice approve/fail/retry/posted once");

  // Overpayment concurrency: two 600 payments on a 1140 invoice, both approved; exactly one reconciles.
  await svc.decideRequest(f.dealerId, early.id, A(approver), "reject", "superseded");
  const p1 = await svc.createRequest(f.dealerId, f.dealId, A(requester), { kind: "payment", date: today, amount: "600", invoiceId: f.invoiceId, sourceId: "bank", paymentMethod: "bank_transfer", payerType: "customer", reference: "BT-2" });
  const p2 = await svc.createRequest(f.dealerId, f.dealId, A(requester), { kind: "payment", date: today, amount: "600", invoiceId: f.invoiceId, sourceId: "bank", paymentMethod: "bank_transfer", payerType: "customer", reference: "BT-3" });
  await expectStatus(svc.decideRequest(f.dealerId, p2.id, A(approver), "approve"), 422, /overpayment/);
  await svc.decideRequest(f.dealerId, p2.id, A(approver), "reject", "would overpay");
  await svc.decideRequest(f.dealerId, p1.id, A(approver), "approve");
  // Simulate a racing legacy-free receipt landing after approval, then run the job.
  await db.insert(paymentsTable).values({ dealerId: f.dealerId, invoiceId: f.invoiceId, customerName: "SFR Test", amount: 600, method: "cash", reference: `race-${nonce}` });
  await assert.rejects(runJob(p1.id));
  const [p1f] = await db.select().from(salesFinanceRequestsTable).where(eq(salesFinanceRequestsTable.id, p1.id));
  assert.equal(p1f!.status, "failed"); assert.match(p1f!.lastError!, /overpay/); assert.equal(p1f!.paymentId, null);
  await db.delete(paymentsTable).where(eq(paymentsTable.reference, `race-${nonce}`));
  await svc.retryRequest(f.dealerId, p1.id, A(approver));
  await Promise.allSettled([runJob(p1.id), runJob(p1.id)]);
  const pays = await db.select().from(paymentsTable).where(eq(paymentsTable.invoiceId, f.invoiceId));
  assert.equal(pays.length, 1, "exactly one local receipt"); assert.equal(pays[0]!.amount, 600);
  assert.equal(pays[0]!.reference, svc.paymentReference({ dealerId: f.dealerId, id: p1.id, reference: "BT-2" }), "idempotency key + customer reference preserved");
  const [p1done] = await db.select().from(salesFinanceRequestsTable).where(eq(salesFinanceRequestsTable.id, p1.id));
  assert.equal(p1done!.status, "posted");
  console.log("ok overpayment guard + exactly-once local receipt");

  // Held legacy entity blocks.
  await db.insert(erpnextSyncJobsTable).values({ dealerId: f.dealerId, direction: "outbound", doctype: "Payment Entry", operation: "insert", entityType: "invoice", entityId: f.invoiceId, payload: { financeReviewHold: true }, status: "dead" });
  const held = await svc.createRequest(f.dealerId, f.dealId, A(requester), { kind: "payment", date: today, amount: "100", invoiceId: f.invoiceId, sourceId: "bank", paymentMethod: "cash", payerType: "customer", reference: "H-1" });
  assert.equal(held.status, "blocked"); assert.ok(held.blockers.some((b) => b.includes("review hold")));
  console.log("ok held legacy entity blocked");

  // Customer-billed expense: journal + actual charge invoice, cost separate.
  const exp = await svc.createRequest(f.dealerId, f.dealId, A(requester), { kind: "expense", date: today, amount: "50", category: "fuel", sourceId: "float", billingTreatment: "customer_billed", customerCharge: "114.00", reference: "FUEL-1" });
  await svc.decideRequest(f.dealerId, exp.id, A(approver), "approve");
  await runJob(exp.id);
  const [expDone] = await db.select().from(salesFinanceRequestsTable).where(eq(salesFinanceRequestsTable.id, exp.id));
  assert.equal(expDone!.status, "posted");
  const [charge] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, expDone!.chargeInvoiceId!));
  assert.equal(charge!.amount, 114); assert.equal(charge!.taxLines[0]!.amount, 14);
  console.log("ok customer-billed expense posts journal + charge invoice");

  // Config change invalidates pending requests.
  const stale = await svc.createRequest(f.dealerId, f.dealId, A(requester), { kind: "expense", date: today, amount: "10", category: "detailing", sourceId: "bank", billingTreatment: "dealer_paid", reference: "PDI-1" });
  await db.update(salesAccountingSettingsTable).set({ revision: 2 }).where(eq(salesAccountingSettingsTable.dealerId, f.dealerId));
  await expectStatus(svc.decideRequest(f.dealerId, stale.id, A(approver), "approve"), 409, /invalidated/);
  console.log("ok config change invalidates approval");
  // Every legacy receipt path refuses enrolled deals (central applyPayment guard).
  const { applyPayment, PaymentGuardError } = await import("../lib/invoicing");
  const [liveInv] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, f.invoiceId));
  await assert.rejects(applyPayment({ invoice: liveInv!, amount: 1, method: "cash", reference: `legacy-${nonce}` }),
    (e: unknown) => e instanceof PaymentGuardError && e.code === "sales_finance_approval_required");
  console.log("ok legacy payment paths blocked for enrolled deal");

  // Authorized wrappers refuse anything but a claimed request.
  await expectStatus(svc.assertAuthorizedPosting(f.dealerId, exp.id, { type: "sales_finance_request", id: exp.id }), 422);
  await expectStatus(svc.assertAuthorizedPosting(other.dealerId, exp.id), 422);
  const { postAuthorizedJournal } = await import("../lib/erpnext/entities");
  await assert.rejects(postAuthorizedJournal(f.dealerId, exp.id, "x", today, []), /not authorized/);
  console.log("ok authorized wrappers gated");

  // Concurrent duplicate posting: winner posts, late loser fails -> stays posted.
  await db.update(salesAccountingSettingsTable).set({ revision: 1 }).where(eq(salesAccountingSettingsTable.dealerId, f.dealerId));
  await svc.decideRequest(f.dealerId, stale.id, A(approver), "reject", "resubmitting");
  const race = await svc.createRequest(f.dealerId, f.dealId, A(requester), { kind: "expense", date: today, amount: "12", category: "detailing", sourceId: "bank", billingTreatment: "dealer_paid", reference: "PDI-2" });
  await svc.decideRequest(f.dealerId, race.id, A(approver), "approve");
  const [raceRow] = await db.select().from(salesFinanceRequestsTable).where(eq(salesFinanceRequestsTable.id, race.id));
  const [raceJob] = await db.select().from(erpnextSyncJobsTable).where(eq(erpnextSyncJobsTable.id, raceRow!.erpJobId!));
  // Whole-run serialization: concurrent successful handlers invoke the remote ONCE.
  journalMode = "slow";
  const before = remoteCalls.filter((c) => c === `JE:${race.id}`).length;
  const [w1, w2] = await Promise.all([svc.executeRequestPosting(raceJob!, remote), svc.executeRequestPosting(raceJob!, remote)]);
  assert.equal(remoteCalls.filter((c) => c === `JE:${race.id}`).length - before, 1, "remote journal created exactly once");
  assert.equal(w1.docName, `JE-${race.id}`); assert.equal(w2.docName, w1.docName);
  const [raceDone] = await db.select().from(salesFinanceRequestsTable).where(eq(salesFinanceRequestsTable.id, race.id));
  assert.equal(raceDone!.status, "posted");
  assert.equal((await svc.executeRequestPosting(raceJob!, remote)).docName, `JE-${race.id}`, "duplicate delivery returns posted result");

  // First failure stays failed for a concurrent duplicate until an explicit retry.
  const race2 = await svc.createRequest(f.dealerId, f.dealId, A(requester), { kind: "expense", date: today, amount: "13", category: "detailing", sourceId: "bank", billingTreatment: "dealer_paid", reference: "PDI-3" });
  await svc.decideRequest(f.dealerId, race2.id, A(approver), "approve");
  const [r2] = await db.select().from(salesFinanceRequestsTable).where(eq(salesFinanceRequestsTable.id, race2.id));
  const [job2] = await db.select().from(erpnextSyncJobsTable).where(eq(erpnextSyncJobsTable.id, r2!.erpJobId!));
  journalMode = "fail";
  const results = await Promise.allSettled([svc.executeRequestPosting(job2!, remote), svc.executeRequestPosting(job2!, remote)]);
  assert.ok(results.every((x) => x.status === "rejected"), "duplicate run does not post after a failure");
  assert.ok(!remoteCalls.includes(`JE:${race2.id}`));
  journalMode = "ok";
  const [r2f] = await db.select().from(salesFinanceRequestsTable).where(eq(salesFinanceRequestsTable.id, race2.id));
  assert.equal(r2f!.status, "failed");
  await svc.retryRequest(f.dealerId, race2.id, A(approver));
  await runJob(race2.id);
  const [r2p] = await db.select().from(salesFinanceRequestsTable).where(eq(salesFinanceRequestsTable.id, race2.id));
  assert.equal(r2p!.status, "posted");
  assert.equal(remoteCalls.filter((c) => c === `JE:${race2.id}`).length, 1);
  console.log("ok whole-run serialization: one remote call; failure stays failed until retry");

  // Post-approval invoice mutation is rejected BEFORE any remote call, and edits are frozen.
  const g = await setup("c");
  const gi = await svc.createRequest(g.dealerId, g.dealId, A(requester), { kind: "invoice", date: today, amount: "1140.00", invoiceId: g.invoiceId, reference: "INV-G" });
  assert.equal(await svc.salesFinanceInvoiceFreeze(g.dealerId, g.invoiceId), gi.id);
  await svc.decideRequest(g.dealerId, gi.id, A(approver), "approve");
  await db.update(invoicesTable).set({ amount: 2280 }).where(eq(invoicesTable.id, g.invoiceId)); // bypassing the frozen route
  const callsBefore = remoteCalls.length;
  await assert.rejects(runJob(gi.id), /changed after approval/);
  assert.equal(remoteCalls.length, callsBefore, "no remote call for a mutated invoice");
  const [giRow] = await db.select().from(salesFinanceRequestsTable).where(eq(salesFinanceRequestsTable.id, gi.id));
  assert.equal(giRow!.status, "failed");
  console.log("ok post-approval invoice mutation blocked before remote");

  // Null remote document name -> failed, never posted.
  await db.update(invoicesTable).set({ amount: 1140 }).where(eq(invoicesTable.id, g.invoiceId));
  await svc.retryRequest(g.dealerId, gi.id, A(approver));
  nullNext = true;
  await assert.rejects(runJob(gi.id), /no Sales Invoice document name/);
  const [giNull] = await db.select().from(salesFinanceRequestsTable).where(eq(salesFinanceRequestsTable.id, gi.id));
  assert.equal(giNull!.status, "failed"); assert.equal(giNull!.erpDocName, null);
  console.log("ok null remote result is not marked posted");

  // Adoption requires exact match: a same-reference receipt for a different amount is refused.
  const [gInv] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, g.invoiceId));
  await svc.retryRequest(g.dealerId, gi.id, A(approver)); await runJob(gi.id); // post invoice so payments are allowed
  const gp = await svc.createRequest(g.dealerId, g.dealId, A(requester), { kind: "payment", date: today, amount: "100", invoiceId: gInv!.id, sourceId: "bank", paymentMethod: "cash", payerType: "customer", reference: "CASH-9" });
  await svc.decideRequest(g.dealerId, gp.id, A(approver), "approve");
  await db.insert(paymentsTable).values({ dealerId: g.dealerId, invoiceId: gInv!.id, customerName: "SFR Test", amount: 99, method: "cash", reference: svc.paymentReference({ dealerId: g.dealerId, id: gp.id, reference: "CASH-9" }) });
  await assert.rejects(runJob(gp.id), /Not adopted/);
  assert.equal((await db.select().from(paymentsTable).where(eq(paymentsTable.invoiceId, gInv!.id))).length, 1);
  console.log("ok receipt adoption requires exact dealer/invoice/amount/method match");
  // Dealer-wide boundary: an UNENROLLED pilot sales deal cannot take old paths;
  // pilot parts invoices and other dealers are unchanged.
  {
    const { withSalesAccountingHold, SalesAccountingHoldError } = await import("../lib/sales-accounting-hold");
    const [v2] = await db.insert(vehiclesTable).values({ dealerId: f.dealerId, make: "BYD", model: "Atto", year: 2026, price: 500, powertrain: "ev", mileageKm: 0, exteriorColor: "Grey", bodyType: "SUV", vin: `SFRU${nonce}` }).returning();
    const [uDeal] = await db.insert(dealsTable).values({ dealerId: f.dealerId, vehicleId: v2!.id, customerName: "Unenrolled", vehiclePrice: 500, otdPrice: 500, stage: "committed" }).returning();
    const mkInv = async (dealerId: number, num: string, extra: Partial<typeof invoicesTable.$inferInsert>) =>
      (await db.insert(invoicesTable).values({ dealerId, invoiceNumber: `${num}-${nonce}`, customerName: "X", kind: "final", status: "issued", amount: 500, ...extra }).returning())[0]!;
    const uInv = await mkInv(f.dealerId, "U", { dealId: uDeal!.id });
    const bookingInv = await mkInv(f.dealerId, "B", { kind: "reservation", description: "Reservation fee — BYD (booking #77)" });
    const partsInv = await mkInv(f.dealerId, "P", { description: "OTC parts sale" });
    const [plain] = await db.insert(dealersTable).values({ name: `SFR ordinary dealer ${nonce}`, status: "provisioning" }).returning();
    dealerIds.push(plain!.id);
    const [pv] = await db.insert(vehiclesTable).values({ dealerId: plain!.id, make: "BYD", model: "Atto", year: 2026, price: 500, powertrain: "ev", mileageKm: 0, exteriorColor: "Grey", bodyType: "SUV", vin: `SFRO${nonce}` }).returning();
    const [pDeal] = await db.insert(dealsTable).values({ dealerId: plain!.id, vehicleId: pv!.id, customerName: "Other", vehiclePrice: 500, otdPrice: 500, stage: "committed" }).returning();
    const otherInv = await mkInv(plain!.id, "O", { dealId: pDeal!.id });
    const refused = (e: unknown) => e instanceof PaymentGuardError && e.code === "sales_finance_approval_required";
    await assert.rejects(applyPayment({ invoice: uInv, amount: 10, method: "cash", reference: `u-${nonce}` }), refused);
    await assert.rejects(applyPayment({ invoice: bookingInv, amount: 10, method: "cash", reference: `b-${nonce}` }), refused);
    assert.ok((await applyPayment({ invoice: partsInv, amount: 10, method: "cash", reference: `p-${nonce}` })).payment.id, "pilot parts receipts unaffected");
    assert.ok((await applyPayment({ invoice: otherInv, amount: 10, method: "cash", reference: `o-${nonce}` })).payment.id, "other dealers unaffected");
    assert.equal(await svc.requiresSalesFinanceApproval(uInv), true);
    assert.equal(await svc.requiresSalesFinanceApproval(otherInv), false);
    assert.equal(await svc.isPilotEnrolledInvoice(f.dealerId, uDeal!.id), false, "no auto-enrolment");
    const job = (dealerId: number, entityId: number) => ({ id: 0, dealerId, direction: "outbound", doctype: "Sales Invoice", operation: "insert", entityType: "invoice", entityId, payload: { action: "create" }, status: "queued", attempts: 0 }) as unknown as import("@workspace/db").ErpnextSyncJob;
    let ran = 0;
    const run = async () => { ran++; return { docName: "X" }; };
    await assert.rejects(withSalesAccountingHold(job(f.dealerId, uInv.id), run), (e: unknown) => e instanceof SalesAccountingHoldError && /not enrolled/.test(String(e)));
    await assert.rejects(withSalesAccountingHold(job(f.dealerId, bookingInv.id), run), SalesAccountingHoldError);
    assert.equal(ran, 0, "legacy handler never ran for pilot sales");
    await withSalesAccountingHold(job(f.dealerId, partsInv.id), run);
    await withSalesAccountingHold(job(plain!.id, otherInv.id), run);
    assert.equal(ran, 2, "parts and other dealers still sync");
    const [pp] = await db.select({ id: paymentsTable.id }).from(paymentsTable).where(eq(paymentsTable.reference, `p-${nonce}`));
    await assert.rejects(withSalesAccountingHold({ ...job(f.dealerId, pp!.id), doctype: "Payment Entry", entityType: "payment" }, run).then(() => { throw new Error("ok"); }), /ok/);
    console.log("ok unenrolled pilot sales deal cannot take old receipt/ERP paths; parts + other dealers unchanged");
  }
  console.log("ALL SALES FINANCE SERVICE TESTS PASSED");
} catch (err) {
  console.error("FAILED", err); process.exitCode = 1;
} finally {
  if (dealerIds.length) {
    const reqs = await db.select({ id: salesFinanceRequestsTable.id }).from(salesFinanceRequestsTable).where(inArray(salesFinanceRequestsTable.dealerId, dealerIds));
    for (const t of [salesFinanceRequestsTable, receiptsTable, paymentsTable, erpnextRefsTable, erpnextSyncJobsTable, invoicesTable, salesAccountingWorkflowsTable, salesAccountingSettingsTable, dealsTable, vehiclesTable, auditLogsTable]) {
      await db.delete(t).where(inArray(t.dealerId, dealerIds));
    }
    void reqs;
    await db.delete(dealersTable).where(inArray(dealersTable.id, dealerIds));
  }
  if (userIds.length) await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  process.exit(process.exitCode ?? 0);
}
