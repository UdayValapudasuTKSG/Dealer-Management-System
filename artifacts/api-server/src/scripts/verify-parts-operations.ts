/** Isolated DEV-only operations fixture. Never imports routes/workers or calls transports. */
export {};
if (process.env.NODE_ENV === "production") throw new Error("DEV-only verifier");
const raw = process.env.DATABASE_URL ?? process.env.DEV_DATABASE_URL;
if (!raw) throw new Error("Development database URL required");
const target = new URL(raw);
if (!["helium", "localhost", "127.0.0.1"].includes(target.hostname)) throw new Error("Database host is not allowlisted for DEV fixtures");
for (const value of [process.env.PROD_DATABASE_URL, process.env.EXTERNAL_DATABASE_URL]) {
  if (!value) continue;
  const production = new URL(value);
  if (production.hostname === target.hostname && production.pathname === target.pathname) throw new Error("Refusing production database");
}
process.env.DATABASE_URL = raw;
process.env.OUTBOX_WORKER_DISABLED = "1";
const assert: typeof import("node:assert/strict") = (await import("node:assert/strict")).default;
const { randomUUID } = await import("node:crypto");
const d = await import("@workspace/db");
const { and, eq, inArray } = await import("drizzle-orm");
const { moveStock, ensureInventory } = await import("../lib/parts-inventory");
const { generateLowStockOrders, startCycleCount, approveCycleCount } = await import("../lib/parts-operations");
const { valuationReport } = await import("../lib/parts-operations-reports");
const tag = `verify-parts-operations-${randomUUID()}`;
const dealerIds: number[] = [];
const userIds: number[] = [];
try {
  const [dealer] = await d.db.insert(d.dealersTable).values({ name: tag }).returning();
  dealerIds.push(dealer.id);
  const dealerId = dealer.id;
  const [actor] = await d.db.insert(d.usersTable).values({ clerkId: tag, name: "Fixture count approver" }).returning();
  userIds.push(actor.id);
  const [average, fifo] = await d.db.insert(d.partsTable).values([
    { dealerId, sku: `${tag}-avg`, name: tag, costingMethod: "average", category: "count-scope", reorderLevel: 0, reorderMax: 0 },
    { dealerId, sku: `${tag}-fifo`, name: tag, costingMethod: "fifo", category: "outside-count", reorderLevel: 0, reorderMax: 0 },
  ]).returning();
  const move = (partId: number, quantityDelta: number, key: string, unitCost?: number) =>
    d.db.transaction(tx => moveStock(tx, { dealerId, partId, quantityDelta, unitCost,
      type: quantityDelta > 0 ? "receipt" : "issue", referenceType: "verification", referenceId: key,
      idempotencyKey: `${tag}:${key}` }));
  for (const part of [average, fifo]) {
    await move(part.id, 10, `${part.id}:receipt-a`, 10);
    await move(part.id, 10, `${part.id}:receipt-b`, 20);
  }
  const beforeIssues = new Date();
  await new Promise(resolve => setTimeout(resolve, 10));
  const averageIssue = await move(average.id, -5, "average-issue");
  const fifoIssue = await move(fifo.id, -5, "fifo-issue");
  await d.db.update(d.partsTable).set({ unitCost: 9999 }).where(and(eq(d.partsTable.dealerId, dealerId), inArray(d.partsTable.id, [average.id, fifo.id])));
  const report = await valuationReport(dealerId, new Date());
  assert.deepEqual({
    average: report.rows.find(r => r.partId === average.id)?.value,
    fifo: report.rows.find(r => r.partId === fifo.id)?.value,
    issueCosts: [averageIssue.unitCostAtTransaction, fifoIssue.unitCostAtTransaction],
  }, { average: 225, fifo: 250, issueCosts: [15, 10] }, "Persisted average/FIFO valuation ignores changed master cost");
  const historical = await valuationReport(dealerId, beforeIssues);
  assert.equal(historical.totalValue, 600, "As-of valuation reconstructs receipts before later consumption");
  console.log("PASS 1-2: persisted average/FIFO and historical valuation");

  const { location } = await d.db.transaction(tx => ensureInventory(tx, dealerId, fifo.id));
  const [destination] = await d.db.insert(d.inventoryLocationsTable).values({ dealerId, name: `${tag}-destination` }).returning();
  await d.db.transaction(async tx => {
    const outgoing = await moveStock(tx, { dealerId, partId: fifo.id, locationId: location.id,
      type: "transfer", quantityDelta: -5, referenceType: "transfer", referenceId: tag });
    await moveStock(tx, { dealerId, partId: fifo.id, locationId: destination.id,
      type: "transfer", quantityDelta: 5, unitCost: outgoing.unitCostAtTransaction, referenceType: "transfer", referenceId: tag });
  });
  const transferred = await valuationReport(dealerId, new Date());
  assert.equal(transferred.totalValue, report.totalValue, "Paired transfer preserves total inventory cost");
  assert.equal(transferred.rows.find(r => r.partId === fifo.id && r.locationId === destination.id)?.value, 50);
  console.log("PASS 3: transfer conserves persisted cost across locations");

  const count = await startCycleCount(dealerId, actor.id, { locationId: location.id, category: "count-scope" });
  await assert.rejects(move(average.id, -1, "count-blocked"), /cycle count/i);
  await move(fifo.id, -1, "outside-count-permitted");
  const [line] = await d.db.select().from(d.inventoryCycleCountLinesTable).where(and(
    eq(d.inventoryCycleCountLinesTable.dealerId, dealerId), eq(d.inventoryCycleCountLinesTable.cycleCountId, count.id)));
  assert.equal(line.partId, average.id);
  console.log("PASS 4: count blocks only scoped inventory; another part remains transactable");
  await d.db.update(d.inventoryCycleCountLinesTable).set({ countedQty: line.expectedQty - 1 }).where(and(
    eq(d.inventoryCycleCountLinesTable.dealerId, dealerId), eq(d.inventoryCycleCountLinesTable.id, line.id)));
  await approveCycleCount(dealerId, actor.id, count.id);
  await approveCycleCount(dealerId, actor.id, count.id);
  const posted = await d.db.select().from(d.inventoryTransactionsTable).where(and(
    eq(d.inventoryTransactionsTable.dealerId, dealerId), eq(d.inventoryTransactionsTable.referenceType, "cycle_count"),
    eq(d.inventoryTransactionsTable.referenceId, String(count.id))));
  assert.deepEqual(posted.map(p => ({ quantity: p.quantityDelta, value: p.valueDelta })), [{ quantity: -1, value: -15 }],
    "Manager approval posts variance once at persisted cost");
  console.log("PASS 5: manager count approval posts variance exactly once");

  const [supplier] = await d.db.insert(d.suppliersTable).values({ dealerId, name: tag }).returning();
  await d.db.insert(d.partsTable).values([
    { dealerId, sku: `${tag}-low-supplier`, name: tag, supplierId: supplier.id, reorderLevel: 2, reorderMax: 8 },
    { dealerId, sku: `${tag}-low-unassigned`, name: tag, reorderLevel: 2, reorderMax: 8 },
  ]);
  const first = await generateLowStockOrders(dealerId, actor.id, location.id);
  const repeat = await generateLowStockOrders(dealerId, actor.id, location.id);
  assert.equal(first.orders.length, 2);
  assert.equal(repeat.orders.length, 0, "Pending drafts satisfy subsequent reorder checks");
  assert.ok(first.orders.every(po => po.status === "draft" && po.sentAt === null && po.sendCount === 0 && po.lines[0].quantity === 8));
  assert.ok(first.orders.some(po => po.needsSupplier && po.supplierId === null));
  const deliveries = await d.db.select().from(d.partNotificationDeliveriesTable).where(eq(d.partNotificationDeliveriesTable.dealerId, dealerId));
  const emailLogs = await d.db.select().from(d.emailLogsTable).where(eq(d.emailLogsTable.dealerId, dealerId));
  assert.equal(deliveries.length + emailLogs.length, 0, "Automatic PO generation neither queues nor sends supplier emails");
  console.log("PASS 6: low-stock drafts are idempotent, preserve needsSupplier review, and never auto-email");
} finally {
  if (dealerIds.length) {
    for (const table of [
      d.partNotificationDeliveriesTable, d.emailLogsTable, d.auditLogsTable,
      d.inventoryCycleCountLinesTable, d.inventoryCycleCountsTable,
      d.purchaseOrderLinesTable, d.purchaseOrdersTable,
      d.inventoryCostConsumptionsTable, d.inventoryCostLayersTable, d.inventoryTransactionsTable,
      d.inventoryHoldsTable, d.inventoryLevelsTable, d.inventoryBinsTable, d.inventoryLocationsTable,
      d.partsTable, d.suppliersTable,
    ]) await d.db.delete(table).where(inArray(table.dealerId, dealerIds));
    await d.db.delete(d.dealersTable).where(inArray(d.dealersTable.id, dealerIds));
  }
  if (userIds.length) await d.db.delete(d.usersTable).where(inArray(d.usersTable.id, userIds));
  await d.pool.end();
}