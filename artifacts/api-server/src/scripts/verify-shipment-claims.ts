/** Dev-only, rollback-only verification of shipment -> reservation authority. */
import assert from "node:assert/strict";
if (process.env.NODE_ENV === "production") throw Error("Development verification only");
const url = process.env.DATABASE_URL ?? process.env.DEV_DATABASE_URL;
if (!url || !["helium", "localhost", "127.0.0.1"].includes(new URL(url).hostname))
  throw Error("Refusing non-local development database");
process.env.OUTBOX_WORKER_DISABLED = "1";
const { db, pool, dealersTable, vehiclesTable, dealsTable, dealItemsTable, invoicesTable, reservationAllocationsTable } = await import("@workspace/db");
const { eq } = await import("drizzle-orm");
const { holdSpecificVehiclesForDeal, SpecificHoldRefused } = await import("../lib/reservation-allocations");
const rollback = new Error("Rollback all verification fixtures");
try {
  await db.transaction(async tx => {
    const [dealer] = await tx.insert(dealersTable).values({ name: `UAT Shipment claim ${Date.now()}` }).returning();
    const [vehicle] = await tx.insert(vehiclesTable).values({
      dealerId: dealer!.id, make: "UAT", model: "Claim verification", year: 2026,
      vin: "UATVERIFY000000001", engineNumber: "UATENGINE000000001", variant: "N/A", price: 100, powertrain: "electric", mileageKm: 0,
      exteriorColor: "White", bodyType: "SUV", status: "available",
    }).returning();
    const [deal] = await tx.insert(dealsTable).values({
      dealerId: dealer!.id, vehicleId: vehicle!.id, vehiclePrice: 100, otdPrice: 100,
      stage: "desking", reservationHoldStatus: "unfulfilled", customerName: "UAT no-contact",
    }).returning();
    const [item] = await tx.insert(dealItemsTable).values({
      dealerId: dealer!.id, dealId: deal!.id, vehicleId: vehicle!.id,
      make: "UAT", model: "Claim verification", modelYear: 2026, variant: "N/A",
      color: "White", quantity: 1, position: 0, vehiclePrice: 100, total: 100,
    }).returning();
    const opts = { dealerId: dealer!.id, dealId: deal!.id,
      units: [{ dealItemId: item!.id, dealItemUnit: 0, vehicleId: vehicle!.id }], actor: "UAT verifier" };
    await assert.rejects(() => holdSpecificVehiclesForDeal(tx, opts), (e: unknown) =>
      e instanceof SpecificHoldRefused && e.handoff === "reservation_payment");
    assert.equal((await tx.select().from(reservationAllocationsTable).where(eq(reservationAllocationsTable.dealId, deal!.id))).length, 0);
    console.log("PASS unpaid reservation cannot claim a VIN");
    const [invoice] = await tx.insert(invoicesTable).values({
      dealerId: dealer!.id, invoiceNumber: `UAT-SHIP-${dealer!.id}`,
      customerName: "UAT no-contact", dealId: deal!.id,
      amount: 100, kind: "reservation", status: "paid",
    }).returning();
    await tx.update(vehiclesTable).set({ recallFlag: true }).where(eq(vehiclesTable.id, vehicle!.id));
    await assert.rejects(() => holdSpecificVehiclesForDeal(tx, opts), /recall/);
    await tx.update(vehiclesTable).set({ recallFlag: false, variant: "Wrong specification" }).where(eq(vehiclesTable.id, vehicle!.id));
    await assert.rejects(() => holdSpecificVehiclesForDeal(tx, opts), /exactly match/);
    await tx.update(vehiclesTable).set({ variant: "N/A" }).where(eq(vehiclesTable.id, vehicle!.id));
    console.log("PASS recalled and wrong-specification vehicles cannot be claimed");
    const held = await holdSpecificVehiclesForDeal(tx, opts);
    assert.equal(held.allocationIds.length, 1);
    const [row] = await tx.select().from(reservationAllocationsTable).where(eq(reservationAllocationsTable.id, held.allocationIds[0]!));
    assert.equal(row!.invoiceId, invoice!.id);
    assert.equal(row!.status, "active");
    console.log("PASS paid reservation binds through existing ledger and preserves invoice provenance");
    await assert.rejects(() => holdSpecificVehiclesForDeal(tx, opts), SpecificHoldRefused);
    assert.equal((await tx.select().from(reservationAllocationsTable).where(eq(reservationAllocationsTable.dealId, deal!.id))).length, 1);
    console.log("PASS repeat confirmation cannot duplicate a hold");
    await assert.rejects(() => holdSpecificVehiclesForDeal(tx, { ...opts, dealerId: dealer!.id + 999999 }), SpecificHoldRefused);
    console.log("PASS foreign dealer cannot claim fixture deal");
    throw rollback;
  });
} catch (err) {
  if (err !== rollback) throw err;
  console.log("PASS all fixtures rolled back; no messages or external calls");
} finally {
  await pool.end();
}
