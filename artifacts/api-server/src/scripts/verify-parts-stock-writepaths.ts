/** DEV-only, fixture-scoped stock regression. No routes, workers, or mail modules imported. */
export {};
if (process.env.NODE_ENV === "production") throw new Error("DEV-only verifier");
const raw = process.env.DATABASE_URL ?? process.env.DEV_DATABASE_URL;
if (!raw) throw new Error("Development database URL required");
const target = new URL(raw);
if (!["helium", "localhost", "127.0.0.1"].includes(target.hostname)) throw new Error("Database host is not allowlisted for DEV fixtures");
if (process.env.PROD_DATABASE_URL) {
  const production = new URL(process.env.PROD_DATABASE_URL);
  if (production.hostname === target.hostname && production.pathname === target.pathname) throw new Error("Refusing production database");
}
process.env.DATABASE_URL = raw;
process.env.OUTBOX_WORKER_DISABLED = "1";
const assert: typeof import("node:assert/strict") = (await import("node:assert/strict")).default;
const { randomUUID } = await import("node:crypto");
const d = await import("@workspace/db");
const { and, eq, inArray } = await import("drizzle-orm");
const { moveStock, createHold, releaseHold } = await import("../lib/parts-inventory");
const { reserveJobPart, issueJobParts, releaseJobPartHolds } = await import("../lib/job-part-stock");
const tag = `verify-stock-${randomUUID()}`;
const dealerIds: number[] = [];
try {
  const dealers = await d.db.insert(d.dealersTable).values([{ name: `${tag}-A` }, { name: `${tag}-B` }]).returning();
  dealerIds.push(...dealers.map(row => row.id));
  const dealerId = dealerIds[0];
  const [part] = await d.db.insert(d.partsTable).values({
    dealerId, sku: tag, name: tag, stock: 5, unitCost: 10, unitPrice: 15,
  }).returning();
  const stock = async () => (await d.db.select().from(d.partsTable).where(eq(d.partsTable.id, part.id)))[0].stock;
  const move = (quantityDelta: number, key: string) => d.db.transaction(tx => moveStock(tx, {
    dealerId, partId: part.id, type: quantityDelta > 0 ? "return" : "issue",
    quantityDelta, referenceType: "verification", referenceId: key, idempotencyKey: `${tag}:${key}`,
  }));
  const race = await Promise.allSettled([move(-4, "race-a"), move(-4, "race-b")]);
  assert.equal(race.filter(row => row.status === "fulfilled").length, 1, "Concurrent oversell must have one winner");
  assert.equal(await stock(), 1);
  await move(4, "reset");
  const hold = await d.db.transaction(tx => createHold(tx, {
    dealerId, partId: part.id, quantity: 3, referenceType: "verification", referenceId: tag,
  }));
  await assert.rejects(move(-3, "reserved-block"), /reserved|available|inventory/i);
  await d.db.transaction(async tx => {
    await releaseHold(tx, dealerId, hold.id);
    await releaseHold(tx, dealerId, hold.id);
  });
  const [level] = await d.db.select().from(d.inventoryLevelsTable).where(and(
    eq(d.inventoryLevelsTable.dealerId, dealerId), eq(d.inventoryLevelsTable.partId, part.id),
  ));
  assert.equal(level.quantityReserved, 0, "Release is idempotent");
  await assert.rejects(d.db.transaction(tx => moveStock(tx, {
    dealerId: dealerIds[1], partId: part.id, type: "issue", quantityDelta: -1,
    referenceType: "verification", referenceId: tag,
  })), /dealership|not found/i);
  const [order] = await d.db.insert(d.serviceOrdersTable).values({
    dealerId, vehicleInfo: tag, scheduledDate: "2026-01-01",
  }).returning();
  const [card] = await d.db.insert(d.jobCardsTable).values({
    dealerId, serviceOrderId: order.id, title: tag,
  }).returning();
  const [line] = await d.db.insert(d.jobCardPartsTable).values({
    dealerId, jobCardId: card.id, partId: part.id, partName: tag,
    kind: "issue", quantity: 2, unitPrice: 15, unitCost: 10, issuedQuantity: 0,
  }).returning();
  await d.db.transaction(tx => reserveJobPart(tx, line));
  assert.equal(await stock(), 5, "Attachment reserves without issuing");
  await assert.rejects(d.db.transaction(async tx => {
    await issueJobParts(tx, dealerId, card.id);
    throw new Error("simulate-invoice-failure");
  }), /simulate-invoice-failure/);
  assert.equal(await stock(), 5, "Failed billing rolls back physical issue");
  await d.db.transaction(tx => issueJobParts(tx, dealerId, card.id));
  await d.db.transaction(tx => issueJobParts(tx, dealerId, card.id));
  assert.equal(await stock(), 3, "Explicit issue then billing cannot double deduct");
  await d.db.insert(d.jobCardPartsTable).values({
    dealerId, jobCardId: card.id, partId: part.id, partName: tag,
    kind: "issue", quantity: 9, unitPrice: 15, unitCost: 10, issuedQuantity: null, backordered: false,
  });
  await d.db.transaction(tx => issueJobParts(tx, dealerId, card.id));
  assert.equal(await stock(), 3, "Legacy history is already issued");
  const returned = () => d.db.transaction(tx => moveStock(tx, {
    dealerId, partId: part.id, type: "return", quantityDelta: 1, nonSellableDelta: 1,
    unitCost: 10, referenceType: "part_credit_note", referenceId: tag,
    idempotencyKey: `${tag}:damaged-return`,
  }));
  await returned(); await returned();
  assert.equal(await stock(), 4, "Return replay cannot double restore stock");
  const [damaged] = await d.db.select().from(d.inventoryLevelsTable).where(eq(d.inventoryLevelsTable.id, level.id));
  assert.equal(damaged.quantityNonSellable, 1, "Damaged returns remain unavailable");
  await d.db.transaction(tx => releaseJobPartHolds(tx, dealerId, card.id));
  await assert.rejects(move(-5, "negative"), /inventory|stock|available/i);
  console.log("PASS concurrency, reservation release, no-negative-stock, atomic billing, legacy, damaged return dedupe, tenant isolation");
} finally {
  if (dealerIds.length) {
    for (const table of [d.inventoryCostConsumptionsTable, d.inventoryCostLayersTable,
      d.inventoryTransactionsTable, d.inventoryHoldsTable, d.inventoryLevelsTable,
      d.jobCardPartsTable, d.jobCardsTable, d.serviceOrdersTable, d.inventoryBinsTable,
      d.inventoryLocationsTable, d.partsTable]) {
      await d.db.delete(table).where(inArray(table.dealerId, dealerIds));
    }
    await d.db.delete(d.dealersTable).where(inArray(d.dealersTable.id, dealerIds));
  }
  await d.pool.end();
}