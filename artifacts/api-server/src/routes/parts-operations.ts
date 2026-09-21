import { Router, type RequestHandler } from "express";
import { z } from "zod/v4";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  db, partsTable, suppliersTable, purchaseOrdersTable, purchaseOrderLinesTable,
  inventoryLocationsTable, inventoryBinsTable, inventoryLevelsTable, inventoryTransactionsTable,
  inventoryHoldsTable, inventoryCycleCountsTable, inventoryCycleCountLinesTable,
  partNotificationDeliveriesTable, partReconciliationsTable, partPricingPoliciesTable, jobCardsTable, jobCardPartsTable, quotesTable,
} from "@workspace/db";
import { activeDealerId, hasPermission } from "../middlewares/rbac";
import {
  PartsOperationError, demand, owned, operationAudit, procurementLock, validateLocation,
  generateLowStockOrders, createSpecialOrder, expirePartsHolds, startCycleCount,
  approveCycleCount, queueSupplierEmail, releaseOperationalHold, holdReferenceIsTerminal, enqueueOperationalStockSync,
} from "../lib/parts-operations";
import { createHold, releaseHold, consumeHold, moveStock } from "../lib/parts-inventory";
import { agingReport, valuationReport, replenishmentReport, reconciliationFlags, csv } from "../lib/parts-operations-reports";
import { partsSmsReadiness } from "../lib/parts-operations-sms";
import { issueJobParts } from "../lib/job-part-stock";
import { calculateLandedUnitCost } from "../lib/parts-landed-cost";

const router = Router();
const id = z.coerce.number().int().positive();
const qty = z.number().int().nonnegative();
const money = z.number().finite().nonnegative();
const text = z.string().trim().min(1).max(500);
const optionalQueryId = (value: unknown) => value === undefined ? undefined : id.parse(value);
type Context = { dealerId: number; actorId: number };
const endpoint = (permission: "view" | "edit" | "approve", fn: (req: any, res: any, context: Context) => Promise<unknown>): RequestHandler => async (req, res) => {
  try {
    const user = res.locals.user;
    if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
    if (!hasPermission(user, "parts", "view") || !hasPermission(user, "parts", permission)) { res.status(403).json({ error: `Parts ${permission} permission required` }); return; }
    const dealerId = activeDealerId(res);
    demand(Number.isSafeInteger(dealerId) && dealerId > 0, "Select a dealer", 400);
    const result = await fn(req, res, { dealerId, actorId: user.id });
    if (!res.headersSent) res.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) { res.status(400).json({ error: "Invalid request", details: error.issues }); return; }
    if (error instanceof PartsOperationError) { res.status(error.status).json({ error: error.message }); return; }
    const e = error as { code?: string; message?: string; status?: number; statusCode?: number };
    if (e.code === "23505") { res.status(409).json({ error: "A record with this key already exists" }); return; }
    if (e.statusCode || e.status) { res.status(e.statusCode ?? e.status ?? 409).json({ error: e.message }); return; }
    if (e.message && /^(This inventory|Insufficient|Inventory hold not found|Part not found|Location not found|Bin not found|Released hold|Idempotency key|Stock movement|Quantity|Non-sellable|Unit cost|Inventory level|Legacy inventory)/.test(e.message)) { res.status(409).json({ error: e.message }); return; }
    res.status(500).json({ error: "Parts operation failed; no changes were committed" });
  }
};
const scope = (table: any, dealerId: number, rowId?: number) => and(eq(table.dealerId, dealerId), rowId ? eq(table.id, rowId) : undefined);

router.get("/locations", endpoint("view", async (_req, _res, c) => db.select().from(inventoryLocationsTable).where(scope(inventoryLocationsTable, c.dealerId))));
router.post("/locations", endpoint("edit", async (req, _res, c) => {
  const input = z.object({ name: text, type: z.enum(["branch", "warehouse"]), address: z.string().max(2000).optional() }).strict().parse(req.body);
  const [row] = await db.insert(inventoryLocationsTable).values({ ...input, dealerId: c.dealerId }).returning(); return row;
}));
router.get("/bins", endpoint("view", async (req, _res, c) => db.select().from(inventoryBinsTable).where(and(scope(inventoryBinsTable, c.dealerId), req.query.locationId ? eq(inventoryBinsTable.locationId, id.parse(req.query.locationId)) : undefined))));
router.post("/bins", endpoint("edit", async (req, _res, c) => {
  const input = z.object({ locationId: id, code: text, description: z.string().max(2000).optional() }).strict().parse(req.body);
  return db.transaction(async tx => { await validateLocation(tx, c.dealerId, input.locationId); const [row] = await tx.insert(inventoryBinsTable).values({ ...input, dealerId: c.dealerId }).returning(); return row; });
}));
for (const kind of ["locations", "bins"] as const) {
  const table = kind === "locations" ? inventoryLocationsTable : inventoryBinsTable;
  router.patch(`/${kind}/:id`, endpoint("edit", async (req, _res, c) => {
    const input = (kind === "locations" ? z.object({ name: text.optional(), type: z.enum(["branch", "warehouse"]).optional(), address: z.string().max(2000).nullable().optional(), active: z.boolean().optional() }) : z.object({ code: text.optional(), description: z.string().max(2000).nullable().optional(), active: z.boolean().optional() })).strict().parse(req.body);
    return db.transaction(async tx => {
      const row = await owned(tx, table, c.dealerId, id.parse(req.params.id), true);
      if (input.active === false) {
        demand(!row.isDefault, "The default inventory location cannot be deactivated");
        const levels = await tx.select().from(inventoryLevelsTable).where(and(scope(inventoryLevelsTable, c.dealerId), kind === "locations" ? eq(inventoryLevelsTable.locationId, row.id) : eq(inventoryLevelsTable.binId, row.id))).for("update");
        demand(!levels.some(l => l.quantityOnHand || l.quantityReserved), "Move stock and release reservations before deactivating");
        const counts = await tx.select().from(inventoryCycleCountsTable).where(and(scope(inventoryCycleCountsTable, c.dealerId), eq(inventoryCycleCountsTable.locationId, kind === "locations" ? row.id : row.locationId), inArray(inventoryCycleCountsTable.status, ["in_progress", "pending_approval"])));
        demand(!counts.some(count => kind === "locations" || count.binId === null || count.binId === row.id), "Finish active cycle counts before deactivating");
        if (kind === "locations") {
          const pending = await tx.select().from(purchaseOrdersTable).where(and(scope(purchaseOrdersTable, c.dealerId), eq(purchaseOrdersTable.locationId, row.id), inArray(purchaseOrdersTable.status, ["draft", "ordered", "sent", "partially_received"])));
          demand(!pending.length, "Close or relocate pending orders before deactivating");
        }
      }
      const [updated] = await tx.update(table).set(input).where(scope(table, c.dealerId, row.id)).returning(); return updated;
    });
  }));
}
router.get("/levels", endpoint("view", async (req, _res, c) => {
  const rows = await db.select().from(inventoryLevelsTable).where(and(scope(inventoryLevelsTable, c.dealerId), req.query.locationId ? eq(inventoryLevelsTable.locationId, id.parse(req.query.locationId)) : undefined, req.query.binId ? eq(inventoryLevelsTable.binId, id.parse(req.query.binId)) : undefined, req.query.partId ? eq(inventoryLevelsTable.partId, id.parse(req.query.partId)) : undefined));
  return rows.map(r => ({ ...r, quantityAvailable: r.quantityOnHand - r.quantityReserved - r.quantityNonSellable }));
}));
router.get("/ledger", endpoint("view", async (req, _res, c) => db.select().from(inventoryTransactionsTable).where(and(scope(inventoryTransactionsTable, c.dealerId), req.query.locationId ? eq(inventoryTransactionsTable.locationId, id.parse(req.query.locationId)) : undefined, req.query.partId ? eq(inventoryTransactionsTable.partId, id.parse(req.query.partId)) : undefined, req.query.from ? sql`${inventoryTransactionsTable.createdAt} >= ${z.coerce.date().parse(req.query.from)}` : undefined, req.query.to ? sql`${inventoryTransactionsTable.createdAt} <= ${z.coerce.date().parse(req.query.to)}` : undefined)).orderBy(desc(inventoryTransactionsTable.id)).limit(z.coerce.number().int().min(1).max(1000).default(250).parse(req.query.limit))));

router.patch("/parts/:id", endpoint("edit", async (req, _res, c) => {
  const input = z.object({ description: z.string().max(10000).nullable().optional(), barcode: z.string().max(100).nullable().optional(), costingMethod: z.enum(["average", "fifo", "landed"]).optional(), reorderMax: qty.optional(), reorderLevel: qty.optional(), active: z.boolean().optional() }).strict().parse(req.body);
  return db.transaction(async tx => {
    const part = await owned(tx, partsTable, c.dealerId, id.parse(req.params.id), true);
    demand((input.reorderMax ?? part.reorderMax) >= (input.reorderLevel ?? part.reorderLevel), "Maximum must not be below minimum", 400);
    if (input.costingMethod && input.costingMethod !== part.costingMethod) {
      const [history] = await tx.select({ id: inventoryTransactionsTable.id }).from(inventoryTransactionsTable).where(and(scope(inventoryTransactionsTable, c.dealerId), eq(inventoryTransactionsTable.partId, part.id))).limit(1);
      demand(!history, "Costing method cannot change after ledger history exists; accounting migration required");
    }
    const [updated] = await tx.update(partsTable).set({ ...input, updatedAt: new Date() }).where(scope(partsTable, c.dealerId, part.id)).returning(); return updated;
  });
}));
router.patch("/suppliers/:id", endpoint("edit", async (req, _res, c) => {
  const input = z.object({ address: z.string().max(2000).nullable().optional(), leadTimeDays: qty.max(3650).optional() }).strict().parse(req.body);
  await owned(db, suppliersTable, c.dealerId, id.parse(req.params.id));
  const [row] = await db.update(suppliersTable).set(input).where(scope(suppliersTable, c.dealerId, id.parse(req.params.id))).returning(); return row;
}));

router.get("/holds", endpoint("view", async (req, _res, c) => db.select().from(inventoryHoldsTable).where(and(scope(inventoryHoldsTable, c.dealerId), req.query.status ? eq(inventoryHoldsTable.status, z.enum(["active", "released", "consumed"]).parse(req.query.status)) : undefined, req.query.locationId ? eq(inventoryHoldsTable.locationId, id.parse(req.query.locationId)) : undefined, req.query.partId ? eq(inventoryHoldsTable.partId, id.parse(req.query.partId)) : undefined)).orderBy(desc(inventoryHoldsTable.id))));
router.post("/holds", endpoint("edit", async (req, _res, c) => {
  const input = z.object({ partId: id, locationId: id, binId: id.nullable().optional(), quantity: qty.positive(), referenceType: z.enum(["job", "estimate", "quote"]), referenceId: id, expiresAt: z.coerce.date().optional() }).strict().parse(req.body);
  demand(!input.expiresAt || input.expiresAt > new Date(), "Hold expiry must be in the future", 400);
  return db.transaction(async tx => {
    await owned(tx, input.referenceType === "quote" ? quotesTable : jobCardsTable, c.dealerId, input.referenceId);
    demand(!await holdReferenceIsTerminal(tx, c.dealerId, input.referenceType, String(input.referenceId)), "Cannot reserve parts for a terminal or expired reference");
    return createHold(tx, { ...input, referenceId: String(input.referenceId), dealerId: c.dealerId, createdBy: c.actorId });
  });
}));
router.post("/holds/:id/release", endpoint("edit", async (req, _res, c) => db.transaction(tx => releaseOperationalHold(tx, c.dealerId, id.parse(req.params.id)))));
router.post("/holds/:id/consume", endpoint("edit", async (req, _res, c) => {
  const result = await db.transaction(async tx => {
  const hold = await owned(tx, inventoryHoldsTable, c.dealerId, id.parse(req.params.id));
  demand(!await holdReferenceIsTerminal(tx, c.dealerId, hold.referenceType, hold.referenceId), "Cannot consume a hold for a terminal or expired reference");
  const [line] = await tx.select().from(jobCardPartsTable).where(and(scope(jobCardPartsTable, c.dealerId), eq(jobCardPartsTable.inventoryHoldId, hold.id)));
  let shouldSync = false;
  if (line) {
    await owned(tx, jobCardsTable, c.dealerId, line.jobCardId, true);
    const issued = await issueJobParts(tx, c.dealerId, line.jobCardId, line.id);
    shouldSync = issued.length > 0;
  } else {
    await consumeHold(tx, c.dealerId, hold.id, { createdBy: c.actorId });
    shouldSync = hold.status === "active";
  }
  const movements = shouldSync ? await tx.select().from(inventoryTransactionsTable).where(and(scope(inventoryTransactionsTable, c.dealerId), eq(inventoryTransactionsTable.idempotencyKey, `hold-consume:${hold.id}`))) : [];
  return { hold: await owned(tx, inventoryHoldsTable, c.dealerId, hold.id), movements };
  });
  for (const movement of result.movements) enqueueOperationalStockSync(movement);
  return result.hold;
}));
router.post("/holds/expire", endpoint("edit", async (_req, _res, c) => expirePartsHolds(c.dealerId)));

const stockInput = z.object({ partId: id, locationId: id, binId: id.nullable().optional(), quantity: qty.positive(), referenceId: text, idempotencyKey: text, notes: z.string().max(2000).optional() });
router.post("/issues", endpoint("edit", async (req, _res, c) => {
  const input = stockInput.strict().parse(req.body);
  const movement = await db.transaction(tx => moveStock(tx, { ...input, dealerId: c.dealerId, type: "issue", quantityDelta: -input.quantity, referenceType: "otc", createdBy: c.actorId }));
  enqueueOperationalStockSync(movement);
  return movement;
}));
router.post("/adjustments", endpoint("approve", async (req, _res, c) => {
  const input = stockInput.omit({ quantity: true }).extend({ quantityDelta: z.number().int().refine(n => n !== 0), unitCost: money.optional(), reason: text }).strict().parse(req.body);
  const movement = await db.transaction(async tx => {
    const result = await moveStock(tx, { ...input, dealerId: c.dealerId, type: "adjustment", referenceType: "manual_adjustment", createdBy: c.actorId, notes: input.reason });
    await operationAudit(tx, c.dealerId, c.actorId, "inventory_transaction", result.id, "Approved inventory adjustment", { reason: input.reason }); return result;
  });
  enqueueOperationalStockSync(movement);
  return movement;
}));
router.post("/transfers", endpoint("edit", async (req, _res, c) => {
  // Deliberately no ERP Stock Entry: AURA location/bin transfers are net-zero
  // within ERP's one configured warehouse until explicit warehouse mapping.
  const input = stockInput.extend({ toLocationId: id, toBinId: id.nullable().optional() }).strict().parse(req.body);
  demand(input.locationId !== input.toLocationId || (input.binId ?? null) !== (input.toBinId ?? null), "Transfer destination must differ", 400);
  return db.transaction(async tx => {
    await validateLocation(tx, c.dealerId, input.toLocationId, input.toBinId);
    const outgoing = await moveStock(tx, { ...input, dealerId: c.dealerId, type: "transfer", quantityDelta: -input.quantity, referenceType: "transfer", createdBy: c.actorId, idempotencyKey: `${input.idempotencyKey}:out` });
    const incoming = await moveStock(tx, { dealerId: c.dealerId, partId: input.partId, locationId: input.toLocationId, binId: input.toBinId, type: "transfer", quantityDelta: input.quantity, referenceType: "transfer", referenceId: input.referenceId, unitCost: outgoing.unitCostAtTransaction, createdBy: c.actorId, idempotencyKey: `${input.idempotencyKey}:in`, notes: input.notes });
    return { outgoing, incoming };
  });
}));

router.get("/purchase-orders", endpoint("view", async (req, _res, c) => {
  const orders = await db.select().from(purchaseOrdersTable).where(and(scope(purchaseOrdersTable, c.dealerId), req.query.status ? eq(purchaseOrdersTable.status, text.parse(req.query.status)) : undefined, req.query.source ? eq(purchaseOrdersTable.source, z.enum(["manual", "low_stock_alert", "special_order"]).parse(req.query.source)) : undefined)).orderBy(desc(purchaseOrdersTable.id));
  const lines = await db.select().from(purchaseOrderLinesTable).where(scope(purchaseOrderLinesTable, c.dealerId));
  return orders.map(po => ({ ...po, needsSupplier: !po.supplierId, lines: lines.filter(l => l.purchaseOrderId === po.id) }));
}));
router.post("/purchase-orders/generate", endpoint("edit", async (req, _res, c) => generateLowStockOrders(c.dealerId, c.actorId, z.object({ locationId: id.optional() }).strict().parse(req.body ?? {}).locationId)));
router.post("/purchase-orders/special-order", endpoint("edit", async (req, _res, c) => createSpecialOrder(c.dealerId, c.actorId, z.object({ partId: id, locationId: id, quantity: qty.positive(), referenceType: z.enum(["job", "estimate"]), referenceId: id, advisorId: id, idempotencyKey: text }).strict().parse(req.body))));
router.post("/purchase-orders", endpoint("edit", async (req, _res, c) => {
  const input = z.object({ supplierId: id.optional(), locationId: id, expectedDate: z.iso.date().optional(), notes: z.string().max(2000).optional(), lines: z.array(z.object({
    partId: id, quantity: qty.positive(), unitCost: money,
    landedCostComponents: z.object({ freight: money.optional(), duty: money.optional(),
      handling: money.optional(), other: money.optional() }).strict().optional(),
  }).strict()).min(1).max(500) }).strict().parse(req.body);
  return db.transaction(async tx => {
    await validateLocation(tx, c.dealerId, input.locationId);
    if (input.supplierId) demand((await owned(tx, suppliersTable, c.dealerId, input.supplierId)).status === "active", "Supplier inactive");
    const lines = [];
    for (const line of input.lines) {
      const part = await owned(tx, partsTable, c.dealerId, line.partId);
      lines.push({ ...line, partName: part.name, landedCostComponents: line.landedCostComponents ?? {},
        landedUnitCost: calculateLandedUnitCost(line.unitCost, line.quantity, line.landedCostComponents) });
    }
    const [po] = await tx.insert(purchaseOrdersTable).values({ dealerId: c.dealerId, supplierId: input.supplierId, locationId: input.locationId, source: "manual", status: "draft", createdBy: c.actorId, needsSupplier: !input.supplierId, expectedDate: input.expectedDate, notes: input.notes }).returning();
    const inserted = await tx.insert(purchaseOrderLinesTable).values(lines.map(l => ({ ...l, dealerId: c.dealerId, purchaseOrderId: po!.id }))).returning(); return { ...po, lines: inserted };
  });
}));
router.patch("/purchase-orders/:id/supplier", endpoint("edit", async (req, _res, c) => {
  const input = z.object({ supplierId: id }).strict().parse(req.body);
  return db.transaction(async tx => {
    await procurementLock(tx, c.dealerId);
    const po = await owned(tx, purchaseOrdersTable, c.dealerId, id.parse(req.params.id), true);
    demand(po.status === "draft", "Only draft orders can change supplier");
    const queued = await tx.select().from(partNotificationDeliveriesTable).where(and(scope(partNotificationDeliveriesTable, c.dealerId), eq(partNotificationDeliveriesTable.type, "supplier.po"), sql`${partNotificationDeliveriesTable.payload}->>'purchaseOrderId' = ${String(po.id)}`, inArray(partNotificationDeliveriesTable.status, ["pending", "sending"])));
    demand(!queued.length, "Supplier email is already queued");
    demand((await owned(tx, suppliersTable, c.dealerId, input.supplierId)).status === "active", "Supplier inactive");
    const [updated] = await tx.update(purchaseOrdersTable).set({ supplierId: input.supplierId, needsSupplier: false }).where(scope(purchaseOrdersTable, c.dealerId, po.id)).returning();
    await operationAudit(tx, c.dealerId, c.actorId, "purchase_order", po.id, "Assigned supplier", { supplierId: input.supplierId }); return updated;
  });
}));
router.post("/purchase-orders/:id/send", endpoint("approve", async (req, _res, c) => {
  const input = z.object({ confirm: z.literal(true), resend: z.boolean().default(false) }).strict().parse(req.body);
  return queueSupplierEmail(c.dealerId, c.actorId, id.parse(req.params.id), input.resend);
}));
router.get("/notifications", endpoint("view", async (req, _res, c) => db.select().from(partNotificationDeliveriesTable).where(and(scope(partNotificationDeliveriesTable, c.dealerId), req.query.status ? eq(partNotificationDeliveriesTable.status, z.enum(["pending", "sending", "sent", "failed"]).parse(req.query.status)) : undefined)).orderBy(desc(partNotificationDeliveriesTable.id)).limit(500)));
router.get("/notifications/sms-settings", endpoint("view", async (_req, _res, c) => partsSmsReadiness(c.dealerId)));
router.post("/notifications/:id/retry", endpoint("approve", async (req, _res, c) => db.transaction(async tx => {
  const row = await owned(tx, partNotificationDeliveriesTable, c.dealerId, id.parse(req.params.id), true);
  demand(row.status === "failed", "Only failed notifications can be retried; sending rows require delivery investigation");
  const [updated] = await tx.update(partNotificationDeliveriesTable).set({ status: "pending", errorMessage: null }).where(scope(partNotificationDeliveriesTable, c.dealerId, row.id)).returning();
  await operationAudit(tx, c.dealerId, c.actorId, "part_notification", row.id, "Approved delivery retry"); return updated;
})));

router.get("/cycle-counts", endpoint("view", async (_req, _res, c) => db.select().from(inventoryCycleCountsTable).where(scope(inventoryCycleCountsTable, c.dealerId)).orderBy(desc(inventoryCycleCountsTable.id))));
router.get("/cycle-counts/:id", endpoint("view", async (req, _res, c) => {
  const count = await owned(db, inventoryCycleCountsTable, c.dealerId, id.parse(req.params.id));
  const lines = await db.select().from(inventoryCycleCountLinesTable).where(and(scope(inventoryCycleCountLinesTable, c.dealerId), eq(inventoryCycleCountLinesTable.cycleCountId, count.id))); return { ...count, lines };
}));
router.post("/cycle-counts", endpoint("edit", async (req, _res, c) => startCycleCount(c.dealerId, c.actorId, z.object({ locationId: id, binId: id.optional(), category: text.optional() }).strict().parse(req.body))));
router.put("/cycle-counts/:id/lines", endpoint("edit", async (req, _res, c) => {
  const input = z.object({ lines: z.array(z.object({ id, countedQuantity: qty })).min(1).max(5000) }).strict().parse(req.body);
  return db.transaction(async tx => {
    const count = await owned(tx, inventoryCycleCountsTable, c.dealerId, id.parse(req.params.id), true);
    demand(["in_progress", "pending_approval"].includes(count.status), "Count is no longer editable");
    for (const line of input.lines) {
      const existing = await owned(tx, inventoryCycleCountLinesTable, c.dealerId, line.id);
      demand(existing.cycleCountId === count.id, "Line is not in this count", 404);
      await tx.update(inventoryCycleCountLinesTable).set({ countedQty: line.countedQuantity, variance: line.countedQuantity - existing.expectedQty }).where(scope(inventoryCycleCountLinesTable, c.dealerId, line.id));
    }
    const lines = await tx.select().from(inventoryCycleCountLinesTable).where(and(scope(inventoryCycleCountLinesTable, c.dealerId), eq(inventoryCycleCountLinesTable.cycleCountId, count.id)));
    await tx.update(inventoryCycleCountsTable).set({ status: lines.every(l => l.countedQty !== null) ? "pending_approval" : "in_progress" }).where(scope(inventoryCycleCountsTable, c.dealerId, count.id)); return lines;
  });
}));
router.post("/cycle-counts/:id/approve", endpoint("approve", async (req, _res, c) => approveCycleCount(c.dealerId, c.actorId, id.parse(req.params.id))));
router.post("/cycle-counts/:id/cancel", endpoint("edit", async (req, _res, c) => db.transaction(async tx => {
  const count = await owned(tx, inventoryCycleCountsTable, c.dealerId, id.parse(req.params.id), true);
  demand(["in_progress", "pending_approval"].includes(count.status), "Count cannot be cancelled");
  const [updated] = await tx.update(inventoryCycleCountsTable).set({ status: "cancelled", completedAt: new Date() }).where(scope(inventoryCycleCountsTable, c.dealerId, count.id)).returning(); return updated;
})));

router.get("/aging", endpoint("view", async (req, res, c) => {
  const thresholds = req.query.thresholds ? String(req.query.thresholds).split(",").map(v => z.coerce.number().int().min(1).max(36500).parse(v)) : [30, 60, 90];
  demand(thresholds.length <= 10 && thresholds.every((n, i) => i === 0 || n > thresholds[i - 1]!), "Thresholds must be ascending unique days", 400);
  const report = await agingReport(c.dealerId, { locationId: optionalQueryId(req.query.locationId), category: req.query.category ? text.parse(req.query.category) : undefined, thresholds });
  if (req.query.format === "csv") { res.type("text/csv").attachment("parts-aging.csv").send(csv(report.rows)); return; } return report;
}));
router.get("/valuation", endpoint("view", async (req, _res, c) => {
  const raw = req.query.asOf;
  let asOf = raw ? z.coerce.date().parse(raw) : new Date();
  // Date-only UI inputs mean end of UTC calendar day; today's value is now,
  // not midnight (which would incorrectly exclude today's receipts).
  if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    asOf = new Date(`${z.iso.date().parse(raw)}T23:59:59.999Z`);
    if (raw === new Date().toISOString().slice(0, 10)) asOf = new Date();
  }
  return valuationReport(c.dealerId, asOf, optionalQueryId(req.query.locationId));
}));
router.get("/replenishment", endpoint("view", async (req, _res, c) => replenishmentReport(c.dealerId, optionalQueryId(req.query.locationId))));

router.get("/reconciliation", endpoint("view", async (req, _res, c) => {
  const rows = await db.select().from(partReconciliationsTable).where(and(scope(partReconciliationsTable, c.dealerId), req.query.status ? eq(partReconciliationsTable.status, z.enum(["pending", "matched", "flagged", "resolved"]).parse(req.query.status)) : undefined)).orderBy(desc(partReconciliationsTable.id));
  const lines = await db.select().from(purchaseOrderLinesTable).where(scope(purchaseOrderLinesTable, c.dealerId));
  const allInvoices = req.query.status ? await db.select().from(partReconciliationsTable).where(scope(partReconciliationsTable, c.dealerId)) : rows;
  return rows.map(r => {
    const line = lines.find(l => l.id === r.purchaseOrderLineId);
    const cumulativeInvoicedQuantity = (r.invoiceQuantity ?? 0) + allInvoices.filter(other => other.purchaseOrderLineId === r.purchaseOrderLineId && other.id < r.id && other.resolution !== "dispute").reduce((n, other) => n + (other.invoiceQuantity ?? 0), 0);
    return { ...r, orderedQuantity: line?.quantity, orderedUnitCost: line?.unitCost, currentReceivedQuantity: line?.qtyReceived, cumulativeInvoicedQuantity, flags: line ? reconciliationFlags(line.quantity, r.receivedQuantity, cumulativeInvoicedQuantity, line.unitCost, r.invoiceUnitCost ?? 0, r.tolerancePercent) : null };
  });
}));
router.post("/reconciliation", endpoint("edit", async (req, _res, c) => {
  const input = z.object({ purchaseOrderId: id, invoiceNumber: text, tolerancePercent: money.max(100).optional(), lines: z.array(z.object({ purchaseOrderLineId: id, quantity: qty, unitCost: money })).min(1).max(500) }).strict().parse(req.body);
  return db.transaction(async tx => {
    await owned(tx, purchaseOrdersTable, c.dealerId, input.purchaseOrderId, true);
    const [policy] = await tx.select().from(partPricingPoliciesTable).where(and(scope(partPricingPoliciesTable, c.dealerId), isNull(partPricingPoliciesTable.category)));
    const tolerance = input.tolerancePercent ?? policy?.reconciliationTolerancePercent ?? 2;
    const results = [];
    demand(new Set(input.lines.map(l => l.purchaseOrderLineId)).size === input.lines.length, "Duplicate invoice lines", 400);
    for (const line of input.lines) {
      const poLine = await owned(tx, purchaseOrderLinesTable, c.dealerId, line.purchaseOrderLineId);
      demand(poLine.purchaseOrderId === input.purchaseOrderId, "Line is not in this purchase order", 404);
      const prior = await tx.select().from(partReconciliationsTable).where(and(scope(partReconciliationsTable, c.dealerId), eq(partReconciliationsTable.purchaseOrderLineId, poLine.id)));
      demand(!prior.some(r => r.invoiceNumber === input.invoiceNumber), "This vendor invoice line has already been recorded");
      const previouslyInvoiced = prior.filter(r => r.resolution !== "dispute").reduce((n, r) => n + (r.invoiceQuantity ?? 0), 0);
      const flags = reconciliationFlags(poLine.quantity, poLine.qtyReceived, line.quantity + previouslyInvoiced, poLine.unitCost, line.unitCost, tolerance);
      const [row] = await tx.insert(partReconciliationsTable).values({ dealerId: c.dealerId, purchaseOrderId: input.purchaseOrderId, purchaseOrderLineId: poLine.id, invoiceNumber: input.invoiceNumber, invoiceQuantity: line.quantity, invoiceUnitCost: line.unitCost, receivedQuantity: poLine.qtyReceived, tolerancePercent: tolerance, status: flags.quantityMismatch || flags.priceMismatch ? "flagged" : "matched", notes: JSON.stringify({ ...flags, previouslyInvoiced }) }).returning(); results.push({ ...row, flags });
    } return results;
  });
}));
router.post("/reconciliation/:id/resolve", endpoint("approve", async (req, _res, c) => {
  const input = z.object({ action: z.enum(["accept", "dispute", "adjust"]), reason: text, quantity: qty.optional(), unitCost: money.optional() }).strict().parse(req.body);
  return db.transaction(async tx => {
    const row = await owned(tx, partReconciliationsTable, c.dealerId, id.parse(req.params.id), true);
    demand(["flagged", "pending"].includes(row.status), "Reconciliation is already closed");
    if (input.action === "adjust") {
      demand(input.quantity !== undefined && input.unitCost !== undefined, "Adjusted quantity and unit cost are required", 400);
      await owned(tx, purchaseOrdersTable, c.dealerId, row.purchaseOrderId, true);
      const line = await owned(tx, purchaseOrderLinesTable, c.dealerId, row.purchaseOrderLineId);
      const invoices = await tx.select().from(partReconciliationsTable).where(and(scope(partReconciliationsTable, c.dealerId), eq(partReconciliationsTable.purchaseOrderLineId, line.id)));
      const others = invoices.filter(r => r.id !== row.id && r.resolution !== "dispute").reduce((n, r) => n + (r.invoiceQuantity ?? 0), 0);
      const flags = reconciliationFlags(line.quantity, line.qtyReceived, input.quantity + others, line.unitCost, input.unitCost, row.tolerancePercent);
      demand(!flags.quantityMismatch && !flags.priceMismatch, "Adjusted invoice still exceeds received/ordered quantity or price tolerance; use accept to explicitly accept a variance");
    }
    const [updated] = await tx.update(partReconciliationsTable).set({ status: "resolved", resolution: input.action, notes: input.reason, resolvedBy: c.actorId, resolvedAt: new Date(), ...(input.action === "adjust" ? { invoiceQuantity: input.quantity, invoiceUnitCost: input.unitCost } : {}) }).where(scope(partReconciliationsTable, c.dealerId, row.id)).returning();
    await operationAudit(tx, c.dealerId, c.actorId, "part_reconciliation", row.id, `Vendor invoice variance: ${input.action}`, { before: row, after: updated, reason: input.reason }); return updated;
  });
}));

export default router;