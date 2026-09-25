import { Router, type RequestHandler } from "express";
import { z } from "zod/v4";
import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
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
import { previewPoEmail, poSnapshotPdf, sendPoPreview } from "../lib/po-communications";
import { nextPoStatus } from "../lib/po-lifecycle-policy";
import { assertNoUnreconciledSupplierInvoices } from "../lib/supplier-invoices";
import { notificationsTable, emailLogsTable, customersTable } from "@workspace/db";

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
router.get("/ledger", endpoint("view", async (req, _res, c) => {
  const where = and(scope(inventoryTransactionsTable, c.dealerId), req.query.locationId ? eq(inventoryTransactionsTable.locationId, id.parse(req.query.locationId)) : undefined, req.query.partId ? eq(inventoryTransactionsTable.partId, id.parse(req.query.partId)) : undefined, req.query.from ? sql`${inventoryTransactionsTable.createdAt} >= ${z.coerce.date().parse(req.query.from)}` : undefined, req.query.to ? sql`${inventoryTransactionsTable.createdAt} <= ${z.coerce.date().parse(req.query.to)}` : undefined);
  const limit = z.coerce.number().int().min(1).max(1000).default(250).parse(req.query.limit);
  if (req.query.paged !== "1") return db.select().from(inventoryTransactionsTable).where(where).orderBy(desc(inventoryTransactionsTable.id)).limit(limit);
  const offset = z.coerce.number().int().min(0).parse(req.query.offset ?? 0);
  const [[total], items] = await Promise.all([
    db.select({ value: count() }).from(inventoryTransactionsTable).where(where),
    db.select().from(inventoryTransactionsTable).where(where).orderBy(desc(inventoryTransactionsTable.id)).limit(limit).offset(offset),
  ]);
  return { items, total: total.value };
}));

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
  const orders = await db.select().from(purchaseOrdersTable).where(and(scope(purchaseOrdersTable, c.dealerId), req.query.status ? eq(purchaseOrdersTable.status, text.parse(req.query.status)) : undefined, req.query.source ? eq(purchaseOrdersTable.source, z.enum(["manual", "import", "low_stock_alert", "special_order"]).parse(req.query.source)) : undefined, req.query.locationId ? eq(purchaseOrdersTable.locationId, id.parse(req.query.locationId)) : undefined, req.query.supplierId ? eq(purchaseOrdersTable.supplierId, id.parse(req.query.supplierId)) : undefined, req.query.from ? sql`${purchaseOrdersTable.createdAt} >= ${z.iso.date().parse(req.query.from)}::date` : undefined, req.query.to ? sql`${purchaseOrdersTable.createdAt} < ${z.iso.date().parse(req.query.to)}::date + interval '1 day'` : undefined)).orderBy(desc(purchaseOrdersTable.id));
  const lines = await db.select().from(purchaseOrderLinesTable).where(scope(purchaseOrderLinesTable, c.dealerId));
  return orders.map(po => ({ ...po, needsSupplier: !po.supplierId, lines: lines.filter(l => l.purchaseOrderId === po.id) }));
}));
router.post("/purchase-orders/generate", endpoint("edit", async (req, _res, c) => generateLowStockOrders(c.dealerId, c.actorId, z.object({ locationId: id.optional() }).strict().parse(req.body ?? {}).locationId)));
router.post("/purchase-orders/special-order", endpoint("edit", async (req, _res, c) => createSpecialOrder(c.dealerId, c.actorId, z.object({ partId: id, locationId: id, quantity: qty.positive(), referenceType: z.enum(["job", "estimate"]), referenceId: id, advisorId: id, idempotencyKey: text }).strict().parse(req.body))));
router.post("/purchase-orders", endpoint("edit", async (req, _res, c) => {
  const input = z.object({ supplierId: id.optional(), locationId: id, expectedDate: z.iso.date().optional(), notes: z.string().max(2000).optional(), lines: z.array(z.object({
    partId: id, quantity: qty.positive(), unitCost: money,
    isSpecialOrder: z.boolean().default(false), customerId: id.nullable().optional(), jobCardId: id.nullable().optional(), requisitionLineId: id.nullable().optional(),
    landedCostComponents: z.object({ freight: money.optional(), duty: money.optional(),
      handling: money.optional(), other: money.optional() }).strict().optional(),
  }).strict()).min(1).max(500) }).strict().parse(req.body);
  return db.transaction(async tx => {
    await validateLocation(tx, c.dealerId, input.locationId);
    if (input.supplierId) demand((await owned(tx, suppliersTable, c.dealerId, input.supplierId)).status === "active", "Supplier inactive");
    const lines = [];
    for (const line of input.lines) {
      const part = await owned(tx, partsTable, c.dealerId, line.partId);
      if (line.customerId) await owned(tx, customersTable, c.dealerId, line.customerId);
      if (line.jobCardId) await owned(tx, jobCardsTable, c.dealerId, line.jobCardId);
      if (line.requisitionLineId) {
        const linked = await tx.execute(sql`select id from part_requisition_lines where dealer_id=${c.dealerId} and id=${line.requisitionLineId}`);
        demand(linked.rows.length, "Requisition line not found", 404);
      }
      lines.push({ ...line, partName: part.name, landedCostComponents: line.landedCostComponents ?? {},
        landedUnitCost: calculateLandedUnitCost(line.unitCost, line.quantity, line.landedCostComponents) });
    }
    const [po] = await tx.insert(purchaseOrdersTable).values({ dealerId: c.dealerId, supplierId: input.supplierId, locationId: input.locationId, source: "manual", status: "draft", createdBy: c.actorId, needsSupplier: !input.supplierId, expectedDate: input.expectedDate, notes: input.notes }).returning();
    const inserted = await tx.insert(purchaseOrderLinesTable).values(lines.map(l => ({ ...l, dealerId: c.dealerId, purchaseOrderId: po!.id }))).returning();
    await operationAudit(tx, c.dealerId, c.actorId, "purchase_order", po!.id, "Created draft purchase order", { before: null, after: "draft", locationId: input.locationId, lineIds: inserted.map(l => l.id) });
    return { ...po, lines: inserted };
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
  const input = z.object({ confirm: z.literal(true), resend: z.boolean().default(false), snapshotId: id, to: z.email(), cc: z.string().max(2000), subject: z.string().min(1).max(300).regex(/^[^\r\n]+$/), html: z.string().min(1).max(100000) }).strict().parse(req.body);
  for (const address of input.cc.split(",").map(s => s.trim()).filter(Boolean)) z.email().parse(address);
  return sendPoPreview(c.dealerId, c.actorId, id.parse(req.params.id), input);
}));
router.post("/purchase-orders/:id/preview", endpoint("approve", async (req, _res, c) => {
  const input = z.object({ resend: z.boolean().default(false) }).strict().parse(req.body ?? {});
  return previewPoEmail(c.dealerId, c.actorId, id.parse(req.params.id), input.resend);
}));
router.put("/suppliers/:id/cc-emails", endpoint("edit", async (req, _res, c) => {
  const input = z.object({ ccEmails: z.array(z.email()).max(20) }).strict().parse(req.body);
  return db.transaction(async tx => {
    const supplier = await owned(tx, suppliersTable, c.dealerId, id.parse(req.params.id), true);
    const [updated] = await tx.update(suppliersTable).set({ ccEmails: [...new Set(input.ccEmails)] }).where(scope(suppliersTable, c.dealerId, supplier.id)).returning();
    await operationAudit(tx, c.dealerId, c.actorId, "supplier", supplier.id, "Updated supplier CC addresses", { before: supplier.ccEmails, after: input.ccEmails });
    return updated;
  });
}));
router.get("/purchase-orders/:id/snapshots/:snapshotId/pdf", endpoint("view", async (req, res, c) => {
  const bytes = await poSnapshotPdf(c.dealerId, id.parse(req.params.id), id.parse(req.params.snapshotId));
  res.setHeader("Cache-Control", "private, no-store");
  res.type("application/pdf").send(bytes);
}));
router.get("/purchase-orders/:id/email-history", endpoint("view", async (req, _res, c) => {
  await owned(db, purchaseOrdersTable, c.dealerId, id.parse(req.params.id));
  const rows = await db.execute(sql`select e.id,e.status,e.sent_at,e.provider_message_id,e.last_error,s.to_address,s.cc,s.subject,s.body_html,s.filename,s.sha256 from po_email_snapshots s join email_logs e on e.id=s.email_log_id where s.dealer_id=${c.dealerId} and s.purchase_order_id=${id.parse(req.params.id)} order by e.id desc`);
  return rows.rows;
}));
router.post("/purchase-orders/:id/close", endpoint("approve", async (req, _res, c) => db.transaction(async tx => {
  const po = await owned(tx, purchaseOrdersTable, c.dealerId, id.parse(req.params.id), true);
  demand(po.status === "received", "Only fully received purchase orders can be closed");
  const installed = await tx.execute(sql`select to_regclass('supplier_invoices') as name`);
  demand(installed.rows[0]?.name, "Supplier invoice reconciliation migration must be installed before closing POs", 503);
  await assertNoUnreconciledSupplierInvoices(tx, c.dealerId, po.id);
  const [updated] = await tx.update(purchaseOrdersTable).set({ status: "closed" }).where(and(scope(purchaseOrdersTable, c.dealerId, po.id), eq(purchaseOrdersTable.status, "received"))).returning();
  demand(updated, "PO changed; reload and retry");
  await operationAudit(tx, c.dealerId, c.actorId, "purchase_order", po.id, "Closed purchase order", { before: "received", after: "closed" });
  return updated;
})));
router.post("/purchase-orders/:id/review", endpoint("edit", async (req, res, c) => {
  const input = z.object({ action: z.enum(["submit", "approve", "return", "cancel"]), comment: z.string().trim().max(2000).optional() }).strict().parse(req.body);
  if (input.action !== "submit") demand(hasPermission(res.locals.user, "parts", "approve"), "Parts approval permission required", 403);
  if (input.action === "return") demand(input.comment, "A return comment is required", 400);
  return db.transaction(async tx => {
    const po = await owned(tx, purchaseOrdersTable, c.dealerId, id.parse(req.params.id), true);
    if (input.action === "submit") {
      demand(po.supplierId && po.locationId, "Supplier and receiving location are required");
      const lines = await tx.select().from(purchaseOrderLinesTable).where(and(scope(purchaseOrderLinesTable, c.dealerId), eq(purchaseOrderLinesTable.purchaseOrderId, po.id)));
      demand(lines.length && lines.every(line => line.quantity > 0), "Add order lines before review");
    }
    const busy = await tx.execute(sql`select e.id from po_email_snapshots s join email_logs e on e.id=s.email_log_id where s.dealer_id=${c.dealerId} and s.purchase_order_id=${po.id} and e.status in ('queued','sending')`);
    demand(!busy.rows.length, "Cannot change a PO while email delivery is pending");
    let status: string;
    try { status = nextPoStatus(po.status, input.action, po.createdBy, c.actorId, hasPermission(res.locals.user, "parts", "admin")); }
    catch (e) { throw new PartsOperationError((e as Error).message); }
    const [updated] = await tx.update(purchaseOrdersTable).set({ status, reviewedBy: input.action === "submit" ? null : c.actorId, reviewedAt: input.action === "submit" ? null : new Date(), reviewComment: input.comment ?? null }).where(and(scope(purchaseOrdersTable, c.dealerId, po.id), eq(purchaseOrdersTable.status, po.status))).returning();
    demand(updated, "PO changed; refresh and try again");
    await operationAudit(tx, c.dealerId, c.actorId, "purchase_order", po.id, `PO ${input.action}`, { before: po.status, after: status, comment: input.comment });
    if (input.action === "return" && po.createdBy) await tx.insert(notificationsTable).values({ dealerId: c.dealerId, userId: po.createdBy, type: "system", title: `PO #${po.id} returned to draft`, body: input.comment!, entityType: "purchase_order_review", entityId: po.id, link: "/parts?tab=orders" }).onConflictDoUpdate({ target: [notificationsTable.dealerId, notificationsTable.userId, notificationsTable.type, notificationsTable.entityType, notificationsTable.entityId], targetWhere: sql`entity_type is not null and entity_id is not null`, set: { body: input.comment!, read: false, updatedAt: new Date() } });
    return updated;
  });
}));
router.patch("/purchase-orders/:id/draft", endpoint("edit", async (req, _res, c) => {
  const input = z.object({ expectedDate: z.iso.date().nullable().optional(), notes: z.string().max(2000).optional(), lines: z.array(z.object({ id, quantity: qty.positive(), unitCost: money, isSpecialOrder: z.boolean(), customerId: id.nullable(), jobCardId: id.nullable(), requisitionLineId: id.nullable() }).strict()).min(1).max(500) }).strict().parse(req.body);
  return db.transaction(async tx => {
    const po = await owned(tx, purchaseOrdersTable, c.dealerId, id.parse(req.params.id), true);
    demand(po.status === "draft", "Only drafts can be edited");
    demand(new Set(input.lines.map(l => l.id)).size === input.lines.length, "Duplicate lines", 400);
    for (const line of input.lines) {
      const current = await owned(tx, purchaseOrderLinesTable, c.dealerId, line.id);
      demand(current.purchaseOrderId === po.id, "Line belongs to another PO", 404);
      if (line.customerId) await owned(tx, customersTable, c.dealerId, line.customerId);
      if (line.jobCardId) await owned(tx, jobCardsTable, c.dealerId, line.jobCardId);
      if (line.requisitionLineId) {
        const linked = await tx.execute(sql`select id from part_requisition_lines where dealer_id=${c.dealerId} and id=${line.requisitionLineId}`);
        demand(linked.rows.length, "Requisition line not found", 404);
      }
      await tx.update(purchaseOrderLinesTable).set({ quantity: line.quantity, unitCost: line.unitCost, isSpecialOrder: line.isSpecialOrder, customerId: line.customerId, jobCardId: line.jobCardId, requisitionLineId: line.requisitionLineId }).where(scope(purchaseOrderLinesTable, c.dealerId, line.id));
    }
    await tx.update(purchaseOrdersTable).set({ expectedDate: input.expectedDate, notes: input.notes, reviewedBy: null, reviewedAt: null }).where(and(scope(purchaseOrdersTable, c.dealerId, po.id), eq(purchaseOrdersTable.status, "draft")));
    await operationAudit(tx, c.dealerId, c.actorId, "purchase_order", po.id, "Edited draft PO", { before: "draft", after: "draft", lines: input.lines });
    return { id: po.id };
  });
}));
router.get("/communication-settings/:locationId", endpoint("view", async (req, _res, c) => {
  const locationId = id.parse(req.params.locationId);
  await validateLocation(db, c.dealerId, locationId);
  const result = await db.execute(sql`select * from po_communication_settings where dealer_id=${c.dealerId} and location_id=${locationId}`);
  return result.rows[0] ?? { location_id: locationId, subject: "Purchase order {{po_number}}", body_html: "<p>Dear {{supplier_name}},</p><p>Please find purchase order {{po_number}} attached for {{branch}}. Expected: {{expected_date}}.</p><p>{{sender_name}}</p>", sms_enabled: false, parts_manager: true, service_manager: true, customer_sms: false };
}));
router.put("/communication-settings/:locationId", endpoint("edit", async (req, res, c) => {
  demand(hasPermission(res.locals.user, "settings", "admin"), "Settings admin permission required", 403);
  const locationId = id.parse(req.params.locationId);
  const input = z.object({ subject: z.string().min(1).max(300).regex(/^[^\r\n]+$/), body_html: z.string().min(1).max(100000), sms_enabled: z.boolean(), parts_manager: z.boolean(), service_manager: z.boolean(), customer_sms: z.boolean() }).strict().parse(req.body);
  const allowed = ["po_number", "supplier_name", "branch", "expected_date", "sender_name"];
  for (const token of (input.subject + input.body_html).matchAll(/\{\{\s*(\w+)\s*\}\}/g)) demand(allowed.includes(token[1]), `Unknown template token ${token[1]}`, 400);
  return db.transaction(async tx => {
    await validateLocation(tx, c.dealerId, locationId);
    await tx.execute(sql`insert into po_communication_settings(dealer_id,location_id,subject,body_html,sms_enabled,parts_manager,service_manager,customer_sms) values(${c.dealerId},${locationId},${input.subject},${input.body_html},${input.sms_enabled},${input.parts_manager},${input.service_manager},${input.customer_sms}) on conflict(dealer_id,location_id) do update set subject=excluded.subject,body_html=excluded.body_html,sms_enabled=excluded.sms_enabled,parts_manager=excluded.parts_manager,service_manager=excluded.service_manager,customer_sms=excluded.customer_sms`);
    await operationAudit(tx, c.dealerId, c.actorId, "parts_communication_settings", locationId, "Updated PO communication settings", input);
    return input;
  });
}));
router.get("/notifications", endpoint("view", async (req, _res, c) => {
  const where = and(scope(partNotificationDeliveriesTable, c.dealerId), req.query.status ? eq(partNotificationDeliveriesTable.status, z.enum(["pending", "sending", "sent", "failed"]).parse(req.query.status)) : undefined);
  if (req.query.paged !== "1") return db.select().from(partNotificationDeliveriesTable).where(where).orderBy(desc(partNotificationDeliveriesTable.id)).limit(500);
  const limit = z.coerce.number().int().min(1).max(1000).default(25).parse(req.query.limit);
  const offset = z.coerce.number().int().min(0).parse(req.query.offset ?? 0);
  const [[total], items] = await Promise.all([
    db.select({ value: count() }).from(partNotificationDeliveriesTable).where(where),
    db.select().from(partNotificationDeliveriesTable).where(where).orderBy(desc(partNotificationDeliveriesTable.id)).limit(limit).offset(offset),
  ]);
  return { items, total: total.value };
}));
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