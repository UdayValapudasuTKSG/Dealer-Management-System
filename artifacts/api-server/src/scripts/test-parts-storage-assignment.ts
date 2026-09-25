/** Development-only transactional regression; intentionally rolls back every fixture. */
export {};
if (process.env.NODE_ENV === "production") throw new Error("Refusing production database");
const url = process.env.DATABASE_URL ?? process.env.DEV_DATABASE_URL;
if (!url || !["helium", "localhost", "127.0.0.1"].includes(new URL(url).hostname)) {
  throw new Error("Allowlisted development database required");
}
if (process.env.PROD_DATABASE_URL) {
  const prod = new URL(process.env.PROD_DATABASE_URL);
  const target = new URL(url);
  if (prod.hostname === target.hostname && prod.pathname === target.pathname) throw new Error("Refusing production database");
}
process.env.DATABASE_URL = url;
process.env.OUTBOX_WORKER_DISABLED = "1";
const assert: typeof import("node:assert/strict") = (await import("node:assert/strict")).default;
const { randomUUID } = await import("node:crypto");
const d = await import("@workspace/db");
const { and, eq } = await import("drizzle-orm");
const { assignPartStorage, moveStock } = await import("../lib/parts-inventory");
const { persistImportedPart } = await import("../lib/parts-imports");
const rollback = `rollback-${randomUUID()}`;
try {
  await d.db.transaction(async tx => {
    const [dealer, foreign] = await tx.insert(d.dealersTable).values([{ name: rollback }, { name: `${rollback}-other` }]).returning();
    const [location] = await tx.insert(d.inventoryLocationsTable).values({ dealerId: dealer.id, name: "Storage" }).returning();
    const [bin] = await tx.insert(d.inventoryBinsTable).values({ dealerId: dealer.id, locationId: location.id, code: "A" }).returning();
    const [foreignLocation] = await tx.insert(d.inventoryLocationsTable).values({ dealerId: foreign.id, name: "Foreign" }).returning();
    const [foreignBin] = await tx.insert(d.inventoryBinsTable).values({ dealerId: foreign.id, locationId: foreignLocation.id, code: "B" }).returning();
    const [part] = await tx.insert(d.partsTable).values({ dealerId: dealer.id, sku: rollback, name: "Test", stock: 0 }).returning();
    await assert.rejects(assignPartStorage(tx, dealer.id, part.id, location.id, foreignBin.id), /Active bin/);
    await assignPartStorage(tx, dealer.id, part.id, location.id, bin.id);
    await moveStock(tx, { dealerId: dealer.id, partId: part.id, locationId: location.id, binId: bin.id,
      type: "opening", quantityDelta: 4, referenceType: "test", referenceId: rollback });
    const [level] = await tx.select().from(d.inventoryLevelsTable).where(and(
      eq(d.inventoryLevelsTable.partId, part.id), eq(d.inventoryLevelsTable.locationId, location.id), eq(d.inventoryLevelsTable.binId, bin.id)));
    assert.equal(level.quantityOnHand, 4);
    const [updated] = await tx.select().from(d.partsTable).where(eq(d.partsTable.id, part.id));
    assert.equal(updated.stock, 4, "Aggregate stock is posted only once");
    const ledger = await tx.select().from(d.inventoryTransactionsTable).where(eq(d.inventoryTransactionsTable.partId, part.id));
    assert.equal(ledger.length, 1, "Opening stock has one ledger entry");
    await persistImportedPart(tx, dealer.id, 1, { sku: rollback, name: "Updated", unitCost: 1, unitPrice: 2 },
      { mode: "upsert", applyStock: false }, updated);
    const [after] = await tx.select().from(d.inventoryLevelsTable).where(eq(d.inventoryLevelsTable.id, level.id));
    assert.equal(after.quantityOnHand, 4, "Metadata updates do not relocate stock");
    throw new Error(rollback);
  });
} catch (error) {
  if (!(error instanceof Error) || error.message !== rollback) throw error;
}
console.log("Parts storage assignment regression passed (fixtures rolled back)");