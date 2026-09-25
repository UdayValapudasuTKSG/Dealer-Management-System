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
const { assignPartStorage, ensureInventory, moveStock, transferPartStock, createHold } = await import("../lib/parts-inventory");
const { persistImportedPart } = await import("../lib/parts-imports");
const rollback = `rollback-${randomUUID()}`;
try {
  await d.db.transaction(async tx => {
    const [dealer, foreign] = await tx.insert(d.dealersTable).values([{ name: rollback }, { name: `${rollback}-other` }]).returning();
    const [location] = await tx.insert(d.inventoryLocationsTable).values({ dealerId: dealer.id, name: "Storage" }).returning();
    const [bin] = await tx.insert(d.inventoryBinsTable).values({ dealerId: dealer.id, locationId: location.id, code: "A" }).returning();
    const [foreignLocation] = await tx.insert(d.inventoryLocationsTable).values({ dealerId: foreign.id, name: "Foreign" }).returning();
    const [foreignBin] = await tx.insert(d.inventoryBinsTable).values({ dealerId: foreign.id, locationId: foreignLocation.id, code: "B" }).returning();
    const [secondBin] = await tx.insert(d.inventoryBinsTable).values({ dealerId: dealer.id, locationId: location.id, code: "C" }).returning();
    const [part] = await tx.insert(d.partsTable).values({ dealerId: dealer.id, sku: rollback, name: "Test", stock: 0 }).returning();
    await assert.rejects(assignPartStorage(tx, dealer.id, part.id, location.id, foreignBin.id), /Active bin/);
    await assignPartStorage(tx, dealer.id, part.id, location.id, bin.id);
    await assignPartStorage(tx, dealer.id, part.id, location.id, secondBin.id);
    let initialLevels = await tx.select().from(d.inventoryLevelsTable).where(eq(d.inventoryLevelsTable.partId, part.id));
    assert.equal(initialLevels.reduce((sum, row) => sum + row.quantityOnHand, 0), 0, "Assignment creates no stock");
    await moveStock(tx, { dealerId: dealer.id, partId: part.id, locationId: location.id, binId: bin.id,
      type: "opening", quantityDelta: 4, referenceType: "test", referenceId: rollback });
    const [level] = await tx.select().from(d.inventoryLevelsTable).where(and(
      eq(d.inventoryLevelsTable.partId, part.id), eq(d.inventoryLevelsTable.locationId, location.id), eq(d.inventoryLevelsTable.binId, bin.id)));
    assert.equal(level.quantityOnHand, 4);
    const [updated] = await tx.select().from(d.partsTable).where(eq(d.partsTable.id, part.id));
    assert.equal(updated.stock, 4, "Aggregate stock is posted only once");
    const ledger = await tx.select().from(d.inventoryTransactionsTable).where(eq(d.inventoryTransactionsTable.partId, part.id));
    assert.equal(ledger.length, 1, "Opening stock has one ledger entry");
    const hold = await createHold(tx, { dealerId: dealer.id, partId: part.id, locationId: location.id, binId: bin.id,
      quantity: 2, referenceType: "test", referenceId: rollback });
    await assert.rejects(transferPartStock(tx, {
      dealerId: dealer.id, partId: part.id, locationId: location.id, binId: bin.id,
      toLocationId: location.id, toBinId: secondBin.id, quantity: 3,
      referenceId: rollback, idempotencyKey: `${rollback}-overreserved`,
    }), /reserved/);
    await assert.rejects(transferPartStock(tx, {
      dealerId: dealer.id, partId: part.id, locationId: location.id, binId: bin.id,
      toLocationId: foreignLocation.id, toBinId: foreignBin.id, quantity: 1,
      referenceId: rollback, idempotencyKey: `${rollback}-foreign`,
    }), /location not found/);
    const pair = await transferPartStock(tx, {
      dealerId: dealer.id, partId: part.id, locationId: location.id, binId: bin.id,
      toLocationId: location.id, toBinId: secondBin.id, quantity: 2,
      referenceId: rollback, idempotencyKey: `${rollback}-partial`,
    });
    assert.equal(pair.outgoing.quantityDelta, -2);
    assert.equal(pair.incoming.quantityDelta, 2);
    const replay = await transferPartStock(tx, {
      dealerId: dealer.id, partId: part.id, locationId: location.id, binId: bin.id,
      toLocationId: location.id, toBinId: secondBin.id, quantity: 2,
      referenceId: rollback, idempotencyKey: `${rollback}-partial`,
    });
    assert.equal(replay.incoming.id, pair.incoming.id, "Replay does not move stock twice");
    initialLevels = await tx.select().from(d.inventoryLevelsTable).where(eq(d.inventoryLevelsTable.partId, part.id));
    assert.equal(initialLevels.reduce((sum, row) => sum + row.quantityOnHand, 0), 4);
    assert.equal(initialLevels.find(row => row.id === level.id)?.quantityOnHand, 2);
    assert.equal(initialLevels.find(row => row.binId === secondBin.id)?.quantityOnHand, 2);
    assert.equal(initialLevels.find(row => row.id === level.id)?.quantityReserved, hold.quantity);
    await assignPartStorage(tx, dealer.id, part.id, location.id, secondBin.id);
    assert.equal((await tx.select().from(d.inventoryLevelsTable).where(eq(d.inventoryLevelsTable.partId, part.id))).length, initialLevels.length,
      "Reassignment does not rewrite occupied levels");
    const [legacy] = await tx.insert(d.partsTable).values({ dealerId: dealer.id, sku: `${rollback}-legacy`, name: "Legacy", stock: 3, unitCost: 5 }).returning();
    await ensureInventory(tx, dealer.id, legacy.id);
    const legacyLevels = await tx.select().from(d.inventoryLevelsTable).where(eq(d.inventoryLevelsTable.partId, legacy.id));
    assert.equal(legacyLevels.reduce((sum, row) => sum + row.quantityOnHand, 0), 3, "Legacy stock adopted exactly once");
    await assignPartStorage(tx, dealer.id, legacy.id, location.id, bin.id);
    assert.equal((await tx.select().from(d.inventoryLevelsTable).where(eq(d.inventoryLevelsTable.partId, legacy.id)))
      .reduce((sum, row) => sum + row.quantityOnHand, 0), 3, "Assignment does not duplicate legacy stock");
    const [fifo] = await tx.insert(d.partsTable).values({
      dealerId: dealer.id, sku: `${rollback}-fifo`, name: "FIFO", stock: 0, costingMethod: "fifo",
    }).returning();
    await assignPartStorage(tx, dealer.id, fifo.id, location.id, bin.id);
    await moveStock(tx, { dealerId: dealer.id, partId: fifo.id, locationId: location.id, binId: bin.id,
      type: "receipt", quantityDelta: 2, unitCost: 5, referenceType: "test", referenceId: rollback });
    await moveStock(tx, { dealerId: dealer.id, partId: fifo.id, locationId: location.id, binId: bin.id,
      type: "receipt", quantityDelta: 2, unitCost: 9, referenceType: "test", referenceId: rollback });
    const fifoTransfer = await transferPartStock(tx, {
      dealerId: dealer.id, partId: fifo.id, locationId: location.id, binId: bin.id,
      toLocationId: location.id, toBinId: secondBin.id, quantity: 3,
      referenceId: rollback, idempotencyKey: `${rollback}-fifo`,
    });
    assert.equal(fifoTransfer.outgoing.valueDelta, -19);
    assert.equal(fifoTransfer.incoming.valueDelta, 19);
    const fifoLayers = await tx.select().from(d.inventoryCostLayersTable).where(and(
      eq(d.inventoryCostLayersTable.partId, fifo.id), eq(d.inventoryCostLayersTable.binId, secondBin.id)));
    assert.deepEqual(fifoLayers.map(layer => [layer.quantityRemaining, layer.unitCost]), [[2, 5], [1, 9]],
      "Destination retains individual source FIFO costs");
    const [damaged] = await tx.insert(d.partsTable).values({ dealerId: dealer.id, sku: `${rollback}-damaged`, name: "Damaged", stock: 0 }).returning();
    await assignPartStorage(tx, dealer.id, damaged.id, location.id, bin.id);
    await moveStock(tx, { dealerId: dealer.id, partId: damaged.id, locationId: location.id, binId: bin.id,
      type: "receipt", quantityDelta: 2, nonSellableDelta: 2, referenceType: "test", referenceId: rollback });
    await assert.rejects(transferPartStock(tx, {
      dealerId: dealer.id, partId: damaged.id, locationId: location.id, binId: bin.id,
      toLocationId: location.id, toBinId: secondBin.id, quantity: 1,
      referenceId: rollback, idempotencyKey: `${rollback}-damaged`,
    }), /Insufficient physical inventory/);
    await persistImportedPart(tx, dealer.id, 1, { sku: rollback, name: "Updated", unitCost: 1, unitPrice: 2 },
      { mode: "upsert", applyStock: false }, updated);
    const [after] = await tx.select().from(d.inventoryLevelsTable).where(eq(d.inventoryLevelsTable.id, level.id));
    assert.equal(after.quantityOnHand, 2, "Metadata updates do not relocate stock");
    throw new Error(rollback);
  });
} catch (error) {
  if (!(error instanceof Error) || error.message !== rollback) throw error;
}
console.log("Parts storage assignment regression passed (fixtures rolled back)");