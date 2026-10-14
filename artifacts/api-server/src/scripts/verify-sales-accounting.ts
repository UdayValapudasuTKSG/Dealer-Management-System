import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, unlink } from "node:fs/promises";
if (process.env.NODE_ENV === "production") throw Error("Development only");
const url = process.env.DATABASE_URL ?? process.env.DEV_DATABASE_URL;
if (!url || !["helium", "localhost", "127.0.0.1"].includes(new URL(url).hostname)) throw Error("Refusing non-local database");
process.env.OUTBOX_WORKER_DISABLED = "1";
const { db, pool, dealersTable, usersTable, rolesTable, dealerUsersTable, vehiclesTable, dealsTable,
  invoicesTable, erpnextSyncJobsTable, erpnextRefsTable, auditLogsTable,
  salesAccountingSettingsTable: settings, salesAccountingWorkflowsTable: workflows, salesAccountingEntriesTable: entries,
} = await import("@workspace/db");
const { and, eq, inArray } = await import("drizzle-orm");
const { withSalesAccountingHold, SalesAccountingHoldError } = await import("../lib/sales-accounting-hold");
const stateFile = "/tmp/sales-accounting-fixture.json";
type Fixture = { dealerIds: number[]; userId: number; email: string; dealId: number; otherDealId: number };
let fixture: Fixture | undefined;
async function cleanup(f: Fixture) {
  for (const table of [entries, workflows, settings, erpnextRefsTable, erpnextSyncJobsTable, invoicesTable, dealsTable, vehiclesTable]) {
    await db.delete(table).where(inArray(table.dealerId, f.dealerIds));
  }
  await db.delete(auditLogsTable).where(eq(auditLogsTable.actorUserId, f.userId));
  await db.delete(auditLogsTable).where(inArray(auditLogsTable.dealerId, f.dealerIds));
  await db.delete(dealerUsersTable).where(eq(dealerUsersTable.userId, f.userId));
  await db.delete(usersTable).where(eq(usersTable.id, f.userId));
  await db.delete(dealersTable).where(inArray(dealersTable.id, f.dealerIds));
}
async function request(path: string, method = "GET", body?: unknown, dealerId = fixture!.dealerIds[0]!) {
  const res = await fetch(`http://localhost:80/api/sales-accounting${path}`, {
    method, headers: { "x-test-user-email": fixture!.email, "x-dealer-id": String(dealerId), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, data: await res.json() as any };
}
try {
  if (process.argv.includes("--cleanup")) {
    fixture = JSON.parse(await readFile(stateFile, "utf8")) as Fixture;
    await cleanup(fixture); fixture = undefined; await unlink(stateFile);
    console.log("Cleaned sales accounting fixtures");
  } else {
    const nonce = randomUUID();
    const [role] = await db.select().from(rolesTable).where(eq(rolesTable.name, "General Manager"));
    assert.ok(role);
    const [user] = await db.insert(usersTable).values({ clerkId: `finance-uat-${nonce}`, email: `finance-${nonce}@example.invalid`, name: "Finance Workflow UAT" }).returning();
    fixture = { dealerIds: [], userId: user!.id, email: user!.email!, dealId: 0, otherDealId: 0 };
    for (const name of ["CAM Motors Dummy", `Finance control other ${nonce}`]) {
      // Provisioning status keeps scheduled dealer sweeps away from test data.
      const [dealer] = await db.insert(dealersTable).values({ name, status: "provisioning" }).returning();
      fixture.dealerIds.push(dealer!.id);
      await db.insert(dealerUsersTable).values({ dealerId: dealer!.id, userId: user!.id, roleId: role.id });
      const [vehicle] = await db.insert(vehiclesTable).values({ dealerId: dealer!.id, make: "BYD", model: "Fixture EV", year: 2026, price: 1140, powertrain: "ev", mileageKm: 0, exteriorColor: "White", bodyType: "SUV" }).returning();
      const [deal] = await db.insert(dealsTable).values({ dealerId: dealer!.id, vehicleId: vehicle!.id, customerName: "Isolated Finance Test", vehiclePrice: 1000, otdPrice: 1140 }).returning();
      if (!fixture.dealId) fixture.dealId = deal!.id; else fixture.otherDealId = deal!.id;
    }
    const [dummy, other] = fixture.dealerIds as [number, number];
    assert.equal((await request("/config")).data.eligible, true);
    assert.equal((await request("/config", "GET", undefined, other)).data.eligible, false);
    const config = { revision: 0, accounts: [{ key: "deposits", account: "Customer deposits - TEST" }],
      sources: [{ id: "bank", label: "Dummy bank", kind: "bank", account: "Bank - TEST" }], models: [] };
    assert.equal((await request("/config", "PUT", config, other)).status, 403);
    assert.equal((await request("/config", "PUT", { ...config, vatPolicy: "delivery_only" })).status, 400);
    assert.equal((await request("/config", "PUT", config)).status, 200);
    assert.equal((await request("/config", "PUT", config)).status, 409, "Stale settings rejected");
    assert.equal((await request(`/deals/${fixture.otherDealId}`)).status, 404);
    assert.equal((await request(`/deals/${fixture.dealId}`, "POST")).status, 200);
    const input = { stage: "VS-03", date: "2026-10-14", amount: 100, sourceId: "bank", reference: "UAT receipt workpaper only", revision: 0 };
    const saved = await request(`/deals/${fixture.dealId}/entries`, "PUT", input);
    assert.equal(saved.status, 200);
    const entry = saved.data.entries[0];
    assert.equal(entry.lines[0].debit, 100);
    assert.equal(entry.lines[1].credit, 100);
    assert.ok(entry.blockers.some((b: string) => b.includes("VAT")));
    assert.equal((await request(`/deals/${fixture.dealId}/entries`, "PUT", input)).status, 409);
    assert.equal((await request(`/deals/${fixture.dealId}/review`, "POST", { stage: "VS-03", revision: 1 })).status, 422, "Unvalidated mappings cannot be reviewed");
    // Even a reviewed, validated workpaper must not call the remote transport.
    await db.update(settings).set({ validation: { state: "valid", errors: [], company: "TEST FIXTURE ONLY" } }).where(eq(settings.dealerId, dummy));
    const resaved = await request(`/deals/${fixture.dealId}/entries`, "PUT", { ...input, revision: 1 });
    assert.equal(resaved.status, 200);
    const reviewed = await request(`/deals/${fixture.dealId}/review`, "POST", { stage: "VS-03", revision: 2 });
    assert.equal(reviewed.status, 200);
    assert.equal(reviewed.data.entries[0].state, "reviewed");
    const [invoice] = await db.insert(invoicesTable).values({ dealerId: dummy, dealId: fixture.dealId, customerName: "UAT", invoiceNumber: `UAT-${nonce}`, amount: 100, kind: "reservation" }).returning();
    const [job] = await db.insert(erpnextSyncJobsTable).values({ dealerId: dummy, direction: "outbound", doctype: "Sales Invoice", entityType: "invoice", entityId: invoice!.id, operation: "insert", status: "dead" }).returning();
    let remoteCalls = 0;
    await assert.rejects(() => withSalesAccountingHold(job!, async () => { remoteCalls++; return null; }), SalesAccountingHoldError);
    assert.equal(remoteCalls, 0);
    const [otherInvoice] = await db.insert(invoicesTable).values({ dealerId: other, dealId: fixture.otherDealId, customerName: "UAT", invoiceNumber: `OTHER-${nonce}`, amount: 100 }).returning();
    await withSalesAccountingHold({ ...job!, dealerId: other, entityId: otherInvoice!.id }, async () => { remoteCalls++; return null; });
    assert.equal(remoteCalls, 1, "Other dealer follows existing handler");
    // The test deliberately clears its fake validation result before leaving
    // fixtures for a browser; it must never appear as real ERP validation.
    await db.update(settings).set({ validation: null }).where(eq(settings.dealerId, dummy));
    console.log("PASS: dummy-only scope, revisions, source-to-GL preview, VAT hold, review controls and legacy ERP transport isolation. No ERPNext calls.");
    if (process.argv.includes("--keep")) {
      await writeFile(stateFile, JSON.stringify(fixture));
      console.log(JSON.stringify(fixture));
      fixture = undefined;
    }
  }
} finally {
  if (fixture) await cleanup(fixture);
  await pool.end();
}
