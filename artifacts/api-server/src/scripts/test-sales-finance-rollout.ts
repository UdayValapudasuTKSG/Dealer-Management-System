import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertDevelopmentDatabase } from "./dev-db-guard";

await assertDevelopmentDatabase();
const { db, dealersTable, vehiclesTable, dealsTable, bookingsTable } = await import("@workspace/db");
const { sql } = await import("drizzle-orm");
const boundary = await import("../lib/sales-finance-boundary");
await boundary.initializeSalesFinanceRollout(db);
const before = await db.execute(sql`SELECT activated_at::text AS value FROM sales_finance_rollout WHERE id=1`);
await Promise.all([boundary.initializeSalesFinanceRollout(db), boundary.initializeSalesFinanceRollout(db)]);
assert.deepEqual((await db.execute(sql`SELECT activated_at::text AS value FROM sales_finance_rollout WHERE id=1`)).rows, before.rows,
  "restart/concurrent startup must retain the activation instant");
const rollback = new Error("rollback isolated rollout fixtures");
try {
  await db.transaction(async tx => {
    const nonce = randomUUID();
    const [a, b] = await tx.insert(dealersTable).values([
      { name: `Rollout ordinary A ${nonce}`, status: "provisioning" },
      { name: `Rollout ordinary B ${nonce}`, status: "provisioning" },
    ]).returning();
    assert.equal(await boundary.isPilotDealerExec(tx, a!.id), true, "all dealers have access");
    assert.equal(await boundary.isPilotDealerExec(tx, b!.id), true);
    assert.equal(await boundary.isPilotDealerExec(tx, -2000000000), false);
    const [v] = await tx.insert(vehiclesTable).values({ dealerId: a!.id, make: "Test", model: "Rollout",
      year: 2026, price: 100, powertrain: "ev", mileageKm: 0, exteriorColor: "Test",
      bodyType: "SUV", vin: `ROLLOUT-${nonce}` }).returning();
    const [old, fresh, converted, edge] = await tx.insert(dealsTable).values(
      ["old", "fresh", "converted", "edge"].map(label => ({ dealerId: a!.id, vehicleId: v!.id,
        customerName: `Rollout ${label}`, vehiclePrice: 100, otdPrice: 100, stage: "desking" }))
    ).returning();
    await tx.execute(sql`UPDATE deals SET created_at=(SELECT activated_at - interval '1 microsecond' FROM sales_finance_rollout WHERE id=1) WHERE id=${old!.id}`);
    await tx.execute(sql`UPDATE deals SET created_at=(SELECT activated_at FROM sales_finance_rollout WHERE id=1) WHERE id=${edge!.id}`);
    assert.equal(await boundary.requiresDealFinanceApproval(tx, a!.id, old!.id), false, "existing sale preserved even one microsecond before activation");
    assert.equal(await boundary.requiresDealFinanceApproval(tx, a!.id, edge!.id), true, "exact activation boundary covered");
    assert.equal(await boundary.requiresDealFinanceApproval(tx, a!.id, fresh!.id), true, "new sale at ordinary dealership covered");
    assert.equal(await boundary.requiresDealFinanceApproval(tx, b!.id, fresh!.id), false, "another dealer cannot acquire this deal");
    const [oldBooking, newBooking] = await tx.insert(bookingsTable).values([
      { dealerId: a!.id, vehicleId: v!.id, customerName: "Old booking", dealId: converted!.id,
        bookingAmount: 10, expiresAt: new Date("2099-01-01"), createdAt: new Date("2000-01-01") },
      { dealerId: a!.id, vehicleId: v!.id, customerName: "New booking",
        bookingAmount: 10, expiresAt: new Date("2099-01-01") },
    ]).returning();
    assert.equal(await boundary.requiresDealFinanceApproval(tx, a!.id, converted!.id), false, "old booking converted later stays existing");
    const invoice = (dealId: number | null, description = "") => ({ dealerId: a!.id, dealId, description });
    assert.equal(await boundary.isPilotSalesInvoice(tx, invoice(old!.id)), false, "a new invoice on an old sale stays legacy");
    assert.equal(await boundary.isPilotSalesInvoice(tx, invoice(fresh!.id)), true);
    assert.equal(await boundary.isPilotSalesInvoice(tx, invoice(null, `Reservation (booking #${oldBooking!.id})`)), false);
    assert.equal(await boundary.isPilotSalesInvoice(tx, invoice(null, `Reservation (booking #${newBooking!.id})`)), true);
    assert.equal(await boundary.isPilotSalesInvoice(tx, invoice(null, "Workshop service")), false);
    assert.equal(await boundary.isPilotSalesInvoice(tx, invoice(null, "OTC parts")), false);
    const ids = await boundary.financeApprovalDealIds(tx, a!.id);
    assert.ok(ids.has(fresh!.id) && ids.has(edge!.id));
    assert.ok(!ids.has(old!.id) && !ids.has(converted!.id), "UI listing matches server enforcement");
    // Existing explicit enrolment remains protected regardless of cutoff.
    await tx.execute(sql`INSERT INTO sales_accounting_workflows (dealer_id,deal_id,started_by) VALUES (${a!.id},${old!.id},0)`);
    assert.equal(await boundary.requiresDealFinanceApproval(tx, a!.id, old!.id), true);
    console.log("PASS: all-dealer availability, persistent cutoff, microsecond boundary, old/new sales, booking conversion, invoice inheritance, tenant isolation, parts/service exclusion, existing enrolment");
    throw rollback;
  });
} catch (err) {
  if (err !== rollback) throw err;
}
process.exit(0);
