import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  erpnextRefsTable,
  erpnextSyncJobsTable,
  partsTable,
  suppliersTable,
  purchaseOrdersTable,
  purchaseOrderLinesTable,
  type ErpnextConnection,
  type ErpnextSyncJob,
  type Part,
} from "@workspace/db";
import { ErpnextClient, ErpnextError } from "./client";
import { clientFor, getErpnextConnection } from "./connection";
import {
  enqueueErpnextSync,
  getErpnextRef,
  registerErpnextSyncHandler,
  saveErpnextRef,
} from "./sync";
import { registerErpnextInboundHandler } from "../../routes/webhooks";
import { notifyPartLowStock } from "../notify-triggers";
import { logger } from "../logger";
import { dealerTimezone, zonedDayKey } from "../timezone";

// ---------------------------------------------------------------------------
// Parts inventory & purchasing ↔ ERPNext.
//
// Outbound (via the durable sync queue — never in a request path):
//   part           → Item              (SKU = item_code, matched to avoid dupes)
//   supplier       → Supplier          (matched by supplier_name)
//   stock movement → Stock Entry       (Material Receipt / Material Issue)
//   purchase order → Purchase Order    (submit on "ordered", cancel on cancel)
//   PO receipt     → Purchase Receipt  (line quantities; PR moves ERPNext stock,
//                                       so no Stock Entry is posted for PO receipts)
//
// Inbound (webhooks): Stock Reconciliation / Stock Entry for mapped Items
// adjust AURA's parts.stock (low-stock crossing preserved) and are logged as
// inbound rows in the sync activity log. AURA-originated Stock Entries are
// recognised by their saved ref and skipped (echo suppression).
// ---------------------------------------------------------------------------

// ————————————————————————— enqueue helpers —————————————————————————

export function enqueuePartItemSync(
  dealerId: number,
  partId: number,
  operation: "insert" | "update",
): void {
  void enqueueErpnextSync({
    dealerId,
    doctype: "Item",
    entityType: "part",
    entityId: partId,
    operation,
    // Only dedupe the initial insert — every later update should re-push.
    ...(operation === "insert"
      ? { dedupeKey: `erp:item:${dealerId}:${partId}:insert` }
      : {}),
  }).catch((err) =>
    logger.warn({ err, dealerId, partId }, "Failed to enqueue ERPNext Item sync"),
  );
}

export function enqueueSupplierSync(
  dealerId: number,
  supplierId: number,
  operation: "insert" | "update" = "insert",
): void {
  void enqueueErpnextSync({
    dealerId,
    doctype: "Supplier",
    entityType: "supplier",
    entityId: supplierId,
    operation,
    ...(operation === "insert"
      ? { dedupeKey: `erp:supplier:${dealerId}:${supplierId}:insert` }
      : {}),
  }).catch((err) =>
    logger.warn({ err, dealerId, supplierId }, "Failed to enqueue ERPNext Supplier sync"),
  );
}

/** Post a stock movement as an ERPNext Stock Entry. `dedupeKey` must be
 * stable for the movement so a retried enqueue can never double-post. */
export function enqueueStockEntrySync(opts: {
  dealerId: number;
  partId: number;
  qty: number;
  direction: "in" | "out";
  entityType: string;
  entityId: number;
  remark: string;
  dedupeKey: string;
}): void {
  if (opts.qty <= 0) return;
  void enqueueErpnextSync({
    dealerId: opts.dealerId,
    doctype: "Stock Entry",
    entityType: opts.entityType,
    entityId: opts.entityId,
    operation: "insert",
    payload: {
      partId: opts.partId,
      qty: opts.qty,
      direction: opts.direction,
      remark: opts.remark,
    },
    dedupeKey: opts.dedupeKey,
  }).catch((err) =>
    logger.warn({ err, ...opts }, "Failed to enqueue ERPNext Stock Entry sync"),
  );
}

export function enqueuePurchaseOrderSync(
  dealerId: number,
  purchaseOrderId: number,
  operation: "insert" | "update",
): void {
  void enqueueErpnextSync({
    dealerId,
    doctype: "Purchase Order",
    entityType: "purchase_order",
    entityId: purchaseOrderId,
    operation,
    ...(operation === "insert"
      ? { dedupeKey: `erp:po:${dealerId}:${purchaseOrderId}:insert` }
      : {}),
  }).catch((err) =>
    logger.warn({ err, dealerId, purchaseOrderId }, "Failed to enqueue ERPNext PO sync"),
  );
}

/** Post a Purchase Receipt for quantities received against an AURA PO. */
export function enqueuePurchaseReceiptSync(opts: {
  dealerId: number;
  purchaseOrderId: number;
  lines: { partId: number; qty: number; rate: number }[];
  dedupeKey: string;
}): void {
  const lines = opts.lines.filter((l) => l.qty > 0);
  if (lines.length === 0) return;
  void enqueueErpnextSync({
    dealerId: opts.dealerId,
    doctype: "Purchase Receipt",
    entityType: "purchase_order",
    entityId: opts.purchaseOrderId,
    operation: "insert",
    payload: { lines },
    dedupeKey: opts.dedupeKey,
  }).catch((err) =>
    logger.warn(
      { err, dealerId: opts.dealerId, purchaseOrderId: opts.purchaseOrderId },
      "Failed to enqueue ERPNext Purchase Receipt sync",
    ),
  );
}

// ————————————————————————— shared resolution —————————————————————————

async function requireConnection(dealerId: number): Promise<{
  conn: ErpnextConnection;
  client: ErpnextClient;
}> {
  const conn = await getErpnextConnection(dealerId);
  if (!conn) throw new ErpnextError("ERPNext is not configured", 0, "network");
  return { conn, client: clientFor(conn) };
}

/** Default warehouse: the per-dealer setting, else the first non-group
 * warehouse in ERPNext. Missing entirely = clear dead-letter, not a retry loop. */
async function resolveWarehouse(
  conn: ErpnextConnection,
  client: ErpnextClient,
): Promise<string> {
  if (conn.defaultWarehouse) return conn.defaultWarehouse;
  const found = await client.listDocs<{ name: string }>("Warehouse", {
    filters: [["is_group", "=", 0]],
    fields: ["name"],
    limit: 1,
  });
  const name = found[0]?.name;
  if (!name) {
    throw new ErpnextError(
      "No warehouse found in ERPNext — set a default warehouse in Settings → ERPNext",
      0,
      "auth", // non-retryable: waiting will not create a warehouse
    );
  }
  return name;
}

/** Resolve (or create) the ERPNext Item for an AURA part. Matches by SKU
 * (item_code) before inserting so backfills never duplicate Items. */
async function ensureItemDoc(
  client: ErpnextClient,
  dealerId: number,
  part: Part,
): Promise<string> {
  const existing = await getErpnextRef(dealerId, "part", part.id, "Item");
  if (existing) return existing;
  const found = await client.listDocs<{ name: string }>("Item", {
    filters: [["item_code", "=", part.sku]],
    fields: ["name"],
    limit: 1,
  });
  let docName = found[0]?.name ?? null;
  if (!docName) {
    const created = await client.insertDoc("Item", {
      item_code: part.sku,
      item_name: part.name.slice(0, 140),
      description: part.name,
      item_group: "All Item Groups",
      stock_uom: "Nos",
      is_stock_item: 1,
      standard_rate: part.unitPrice,
      valuation_rate: part.unitCost,
    });
    docName = created.name;
  }
  await saveErpnextRef(dealerId, "part", part.id, "Item", docName);
  return docName;
}

/** Resolve (or create) the ERPNext Supplier for an AURA supplier. */
async function ensureSupplierDoc(
  client: ErpnextClient,
  dealerId: number,
  supplier: { id: number; name: string },
): Promise<string> {
  const existing = await getErpnextRef(dealerId, "supplier", supplier.id, "Supplier");
  if (existing) return existing;
  const found = await client.listDocs<{ name: string }>("Supplier", {
    filters: [["supplier_name", "=", supplier.name]],
    fields: ["name"],
    limit: 1,
  });
  let docName = found[0]?.name ?? null;
  if (!docName) {
    const created = await client.insertDoc("Supplier", {
      supplier_name: supplier.name,
      supplier_group: "All Supplier Groups",
      supplier_type: "Company",
    });
    docName = created.name;
  }
  await saveErpnextRef(dealerId, "supplier", supplier.id, "Supplier", docName);
  return docName;
}

async function loadPart(dealerId: number, partId: number): Promise<Part | null> {
  const [part] = await db
    .select()
    .from(partsTable)
    .where(and(eq(partsTable.id, partId), eq(partsTable.dealerId, dealerId)));
  return part ?? null;
}

// ————————————————————————— outbound handlers —————————————————————————

async function itemHandler(job: ErpnextSyncJob): Promise<{ docName: string | null }> {
  const part = await loadPart(job.dealerId, job.entityId);
  if (!part) return { docName: null }; // part vanished — nothing to sync
  const { client } = await requireConnection(job.dealerId);
  const docName = await ensureItemDoc(client, job.dealerId, part);
  // ensureItemDoc only creates; push current fields for updates/backfill.
  await client.updateDoc("Item", docName, {
    item_name: part.name.slice(0, 140),
    description: part.name,
    standard_rate: part.unitPrice,
    valuation_rate: part.unitCost,
    disabled: part.status === "obsolete" ? 1 : 0,
  });
  return { docName };
}

async function supplierHandler(job: ErpnextSyncJob): Promise<{ docName: string | null }> {
  const [supplier] = await db
    .select()
    .from(suppliersTable)
    .where(
      and(
        eq(suppliersTable.id, job.entityId),
        eq(suppliersTable.dealerId, job.dealerId),
      ),
    );
  if (!supplier) return { docName: null };
  const { client } = await requireConnection(job.dealerId);
  const docName = await ensureSupplierDoc(client, job.dealerId, supplier);
  await client.updateDoc("Supplier", docName, {
    supplier_name: supplier.name,
    ...(supplier.email ? { email_id: supplier.email } : {}),
    ...(supplier.phone ? { mobile_no: supplier.phone } : {}),
  });
  return { docName };
}

async function stockEntryHandler(job: ErpnextSyncJob): Promise<{ docName: string | null }> {
  const p = job.payload as {
    partId?: number;
    qty?: number;
    direction?: string;
    remark?: string;
  };
  if (!p.partId || !p.qty || (p.direction !== "in" && p.direction !== "out")) {
    throw new ErpnextError("Malformed Stock Entry payload", 0, "auth"); // non-retryable
  }
  const part = await loadPart(job.dealerId, p.partId);
  if (!part) return { docName: null };
  const { conn, client } = await requireConnection(job.dealerId);
  const itemCode = await ensureItemDoc(client, job.dealerId, part);
  const warehouse = await resolveWarehouse(conn, client);
  const receipt = p.direction === "in";
  // The "AURA" remark prefix doubles as a race-free echo marker: the inbound
  // Stock Entry webhook skips docs carrying it even when ERPNext's webhook
  // arrives before this worker saved the doc ref.
  const remark = p.remark?.startsWith("AURA")
    ? p.remark
    : `AURA: ${p.remark ?? "stock movement"}`;
  const created = await client.insertDoc("Stock Entry", {
    stock_entry_type: receipt ? "Material Receipt" : "Material Issue",
    purpose: receipt ? "Material Receipt" : "Material Issue",
    docstatus: 1,
    remarks: remark,
    items: [
      {
        item_code: itemCode,
        qty: p.qty,
        ...(receipt
          ? { t_warehouse: warehouse, basic_rate: part.unitCost, allow_zero_valuation_rate: 1 }
          : { s_warehouse: warehouse }),
      },
    ],
  });
  return { docName: created.name };
}

/** AURA PO status → ERPNext docstatus. */
function poDocstatus(status: string): 0 | 1 | 2 {
  if (status === "draft") return 0;
  if (status === "cancelled") return 2;
  return 1; // ordered / partially_received / received
}

async function purchaseOrderHandler(job: ErpnextSyncJob): Promise<{ docName: string | null }> {
  const [po] = await db
    .select()
    .from(purchaseOrdersTable)
    .where(
      and(
        eq(purchaseOrdersTable.id, job.entityId),
        eq(purchaseOrdersTable.dealerId, job.dealerId),
      ),
    );
  if (!po) return { docName: null };
  const { conn, client } = await requireConnection(job.dealerId);
  const existing = await getErpnextRef(
    job.dealerId,
    "purchase_order",
    po.id,
    "Purchase Order",
  );

  if (existing) {
    // A submitted ERPNext PO only accepts docstatus transitions; field edits
    // are draft-only. Cancel → 2, place → 1, otherwise sync draft fields.
    const target = poDocstatus(po.status);
    if (target === 2) {
      await client.updateDoc("Purchase Order", existing, { docstatus: 2 });
    } else if (target === 1) {
      await client.updateDoc("Purchase Order", existing, { docstatus: 1 });
    } else {
      await client.updateDoc("Purchase Order", existing, {
        ...(po.expectedDate ? { schedule_date: po.expectedDate } : {}),
        ...(po.notes !== null ? { terms: po.notes } : {}),
      });
    }
    return { docName: existing };
  }

  if (po.status === "cancelled") return { docName: null }; // never pushed — skip

  const lines = await db
    .select()
    .from(purchaseOrderLinesTable)
    .where(
      and(
        eq(purchaseOrderLinesTable.purchaseOrderId, po.id),
        eq(purchaseOrderLinesTable.dealerId, job.dealerId),
      ),
    );
  if (lines.length === 0) return { docName: null };
  const parts = await db
    .select()
    .from(partsTable)
    .where(
      and(
        eq(partsTable.dealerId, job.dealerId),
        inArray(
          partsTable.id,
          [...new Set(lines.map((l) => l.partId).filter((id): id is number => id != null))],
        ),
      ),
    );
  const partById = new Map(parts.map((p) => [p.id, p]));

  let supplierDoc: string;
  if (po.supplierId != null) {
    const [supplier] = await db
      .select()
      .from(suppliersTable)
      .where(
        and(
          eq(suppliersTable.id, po.supplierId),
          eq(suppliersTable.dealerId, job.dealerId),
        ),
      );
    supplierDoc = supplier
      ? await ensureSupplierDoc(client, job.dealerId, supplier)
      : await ensureSupplierDoc(client, job.dealerId, { id: 0, name: "Unspecified Supplier" });
  } else {
    supplierDoc = await ensureSupplierDoc(client, job.dealerId, {
      id: 0,
      name: "Unspecified Supplier",
    });
  }

  const warehouse = await resolveWarehouse(conn, client);
  const scheduleDate =
    po.expectedDate ??
    zonedDayKey(new Date(), await dealerTimezone(job.dealerId));
  const items: Record<string, unknown>[] = [];
  for (const line of lines) {
    if (line.partId == null) continue;
    const part = partById.get(line.partId);
    if (!part) continue;
    items.push({
      item_code: await ensureItemDoc(client, job.dealerId, part),
      qty: line.quantity,
      rate: line.unitCost,
      schedule_date: scheduleDate,
      warehouse,
    });
  }
  if (items.length === 0) return { docName: null };
  const created = await client.insertDoc("Purchase Order", {
    supplier: supplierDoc,
    schedule_date: scheduleDate,
    docstatus: poDocstatus(po.status) === 0 ? 0 : 1,
    items,
    ...(po.reference ? { po_no: po.reference } : {}),
    ...(po.notes ? { terms: po.notes } : {}),
  });
  return { docName: created.name };
}

async function purchaseReceiptHandler(job: ErpnextSyncJob): Promise<{ docName: string | null }> {
  const p = job.payload as { lines?: { partId: number; qty: number; rate: number }[] };
  const linesIn = (p.lines ?? []).filter((l) => l.qty > 0);
  if (linesIn.length === 0) return { docName: null };
  const [po] = await db
    .select()
    .from(purchaseOrdersTable)
    .where(
      and(
        eq(purchaseOrdersTable.id, job.entityId),
        eq(purchaseOrdersTable.dealerId, job.dealerId),
      ),
    );
  const { conn, client } = await requireConnection(job.dealerId);
  const warehouse = await resolveWarehouse(conn, client);

  let supplierDoc = "Unspecified Supplier";
  if (po?.supplierId != null) {
    const [supplier] = await db
      .select()
      .from(suppliersTable)
      .where(
        and(
          eq(suppliersTable.id, po.supplierId),
          eq(suppliersTable.dealerId, job.dealerId),
        ),
      );
    if (supplier) supplierDoc = await ensureSupplierDoc(client, job.dealerId, supplier);
    else supplierDoc = await ensureSupplierDoc(client, job.dealerId, { id: 0, name: "Unspecified Supplier" });
  } else {
    supplierDoc = await ensureSupplierDoc(client, job.dealerId, {
      id: 0,
      name: "Unspecified Supplier",
    });
  }

  const poDocName = po
    ? await getErpnextRef(job.dealerId, "purchase_order", po.id, "Purchase Order")
    : null;

  const items: Record<string, unknown>[] = [];
  for (const line of linesIn) {
    const part = await loadPart(job.dealerId, line.partId);
    if (!part) continue;
    items.push({
      item_code: await ensureItemDoc(client, job.dealerId, part),
      qty: line.qty,
      rate: line.rate,
      warehouse,
      ...(poDocName ? { purchase_order: poDocName } : {}),
    });
  }
  if (items.length === 0) return { docName: null };
  const created = await client.insertDoc("Purchase Receipt", {
    supplier: supplierDoc,
    docstatus: 1,
    items,
  });
  return { docName: created.name };
}

// ————————————————————————— inbound (webhooks) —————————————————————————

/** Map an ERPNext item_code back to the AURA part: ref first, then SKU. */
async function partForItemCode(
  dealerId: number,
  itemCode: string,
): Promise<Part | null> {
  const [ref] = await db
    .select({ entityId: erpnextRefsTable.entityId })
    .from(erpnextRefsTable)
    .where(
      and(
        eq(erpnextRefsTable.dealerId, dealerId),
        eq(erpnextRefsTable.entityType, "part"),
        eq(erpnextRefsTable.doctype, "Item"),
        eq(erpnextRefsTable.docName, itemCode),
      ),
    );
  if (ref) return loadPart(dealerId, ref.entityId);
  const [bySku] = await db
    .select()
    .from(partsTable)
    .where(and(eq(partsTable.dealerId, dealerId), eq(partsTable.sku, itemCode)));
  return bySku ?? null;
}

/**
 * Atomically claim an inbound ERPNext stock document so it is applied at most
 * once, no matter how many times (or under how many lifecycle events) ERPNext
 * delivers the webhook. Submitted stock documents are immutable in ERPNext,
 * so once-per-(dealer, doctype, docName) is the correct semantics.
 * Returns the claimed log row id, or null when the doc was already processed.
 */
async function claimInboundDoc(
  dealerId: number,
  doctype: string,
  docName: string,
): Promise<number | null> {
  const [row] = await db
    .insert(erpnextSyncJobsTable)
    .values({
      dealerId,
      direction: "inbound",
      doctype,
      operation: "update",
      entityType: "erpnext_doc",
      entityId: 0,
      payload: {},
      status: "processing",
      erpnextDocName: docName,
      dedupeKey: `erp:inbound:${dealerId}:${doctype}:${docName}`,
    })
    .onConflictDoNothing({ target: erpnextSyncJobsTable.dedupeKey })
    .returning({ id: erpnextSyncJobsTable.id });
  return row?.id ?? null;
}

/** Apply an externally-driven stock change: update stock + alert on crossing.
 * Returns a log entry describing the change. */
async function applyInboundStockChange(opts: {
  dealerId: number;
  part: Part;
  newStock: number;
}): Promise<Record<string, unknown> | null> {
  const { part, newStock } = opts;
  if (newStock === part.stock) return null;
  await db
    .update(partsTable)
    .set({ stock: newStock })
    .where(
      and(eq(partsTable.id, part.id), eq(partsTable.dealerId, opts.dealerId)),
    );
  // Low-stock crossing logic mirrors checkLowStockCrossing in routes/parts.
  if (part.stock > part.reorderLevel && newStock <= part.reorderLevel) {
    notifyPartLowStock({
      id: part.id,
      dealerId: part.dealerId,
      sku: part.sku,
      name: part.name,
      stock: newStock,
      reorderLevel: part.reorderLevel,
    });
  }
  return {
    partId: part.id,
    itemCode: part.sku,
    stockBefore: part.stock,
    stockAfter: newStock,
  };
}

/** Mark a claimed inbound doc processed and record what changed. */
async function finishInboundDoc(
  logId: number,
  changes: Record<string, unknown>[],
  extra: Record<string, unknown>,
): Promise<void> {
  await db
    .update(erpnextSyncJobsTable)
    .set({
      status: "succeeded",
      payload: { changes, ...extra },
      // Single-part docs get a real entity pointer for the activity log.
      ...(changes.length === 1 && typeof changes[0]?.["partId"] === "number"
        ? { entityType: "part", entityId: changes[0]["partId"] as number }
        : {}),
      completedAt: new Date(),
    })
    .where(eq(erpnextSyncJobsTable.id, logId));
}

type InboundEvent = {
  dealerId: number;
  doctype: string;
  docName: string | null;
  event: string | null;
  payload: Record<string, unknown>;
};

type InboundItemRow = {
  item_code?: string;
  qty?: number;
  s_warehouse?: string | null;
  t_warehouse?: string | null;
};

/** Warehouse scope: with a configured default warehouse, only rows touching
 * it may move AURA stock (AURA models exactly one warehouse); without one,
 * all rows count (single-warehouse ERPNext). */
function warehouseMatches(
  configured: string | null,
  rowWarehouse: string | null | undefined,
): boolean {
  return !configured || rowWarehouse === configured;
}

async function inboundStockReconciliation(event: InboundEvent): Promise<void> {
  if (event.event === "on_trash" || event.event === "on_cancel") return;
  if (!event.docName) return;
  const items = Array.isArray(event.payload["items"])
    ? (event.payload["items"] as (InboundItemRow & { warehouse?: string })[])
    : [];
  if (items.length === 0) return;
  const logId = await claimInboundDoc(
    event.dealerId,
    "Stock Reconciliation",
    event.docName,
  );
  if (logId === null) return; // already applied — duplicate delivery
  const conn = await getErpnextConnection(event.dealerId);
  const wh = conn?.defaultWarehouse ?? null;
  const changes: Record<string, unknown>[] = [];
  for (const row of items) {
    if (!row.item_code || typeof row.qty !== "number") continue;
    if (!warehouseMatches(wh, row.warehouse)) continue;
    const part = await partForItemCode(event.dealerId, row.item_code);
    if (!part) continue;
    const change = await applyInboundStockChange({
      dealerId: event.dealerId,
      part,
      newStock: Math.max(0, Math.round(row.qty)),
    });
    if (change) changes.push(change);
  }
  await finishInboundDoc(logId, changes, {
    reason: "Stock reconciliation in ERPNext",
    warehouseScope: wh,
  });
}

async function inboundStockEntry(event: InboundEvent): Promise<void> {
  if (event.event === "on_trash" || event.event === "on_cancel") return;
  if (!event.docName) return;
  // Echo suppression 1 (race-free): AURA-posted Stock Entries always carry an
  // "AURA" remark prefix inside the document itself, so they are recognisable
  // even if the webhook beats the sync worker's ref write.
  const remarks = event.payload["remarks"];
  if (typeof remarks === "string" && remarks.startsWith("AURA")) return;
  // Echo suppression 2: Stock Entries AURA itself posted have a saved ref.
  const [ours] = await db
    .select({ id: erpnextRefsTable.id })
    .from(erpnextRefsTable)
    .where(
      and(
        eq(erpnextRefsTable.dealerId, event.dealerId),
        eq(erpnextRefsTable.doctype, "Stock Entry"),
        eq(erpnextRefsTable.docName, event.docName),
      ),
    );
  if (ours) return;
  // Only act on submitted entries (docstatus 1) when the payload carries it.
  const docstatus = event.payload["docstatus"];
  if (typeof docstatus === "number" && docstatus !== 1) return;
  const items = Array.isArray(event.payload["items"])
    ? (event.payload["items"] as InboundItemRow[])
    : [];
  if (items.length === 0) return;
  const logId = await claimInboundDoc(event.dealerId, "Stock Entry", event.docName);
  if (logId === null) return; // already applied — duplicate delivery
  const conn = await getErpnextConnection(event.dealerId);
  const wh = conn?.defaultWarehouse ?? null;
  const changes: Record<string, unknown>[] = [];
  for (const row of items) {
    if (!row.item_code || typeof row.qty !== "number") continue;
    const part = await partForItemCode(event.dealerId, row.item_code);
    if (!part) continue;
    // Row-level direction, scoped to the AURA-modelled warehouse: target
    // warehouse = into stock, source = out; transfers between foreign
    // warehouses (or into/out of unscoped ones) don't touch AURA stock.
    const delta =
      (row.t_warehouse && warehouseMatches(wh, row.t_warehouse) ? row.qty : 0) -
      (row.s_warehouse && warehouseMatches(wh, row.s_warehouse) ? row.qty : 0);
    if (!delta) continue;
    const change = await applyInboundStockChange({
      dealerId: event.dealerId,
      part,
      newStock: Math.max(0, part.stock + Math.round(delta)),
    });
    if (change) changes.push(change);
  }
  await finishInboundDoc(logId, changes, {
    reason: "Stock Entry created in ERPNext",
    warehouseScope: wh,
  });
}

// ————————————————————————— backfill —————————————————————————

/** Push existing parts, suppliers and open POs for a dealer to ERPNext.
 * Items are matched by SKU in the handler so re-runs never duplicate. */
export async function backfillErpnextParts(dealerId: number): Promise<{
  parts: number;
  suppliers: number;
  purchaseOrders: number;
}> {
  const parts = await db
    .select({ id: partsTable.id })
    .from(partsTable)
    .where(eq(partsTable.dealerId, dealerId));
  for (const p of parts) {
    await enqueueErpnextSync({
      dealerId,
      doctype: "Item",
      entityType: "part",
      entityId: p.id,
      operation: "update",
      dedupeKey: `erp:backfill:item:${dealerId}:${p.id}`,
    });
  }
  const suppliers = await db
    .select({ id: suppliersTable.id })
    .from(suppliersTable)
    .where(eq(suppliersTable.dealerId, dealerId));
  for (const s of suppliers) {
    await enqueueErpnextSync({
      dealerId,
      doctype: "Supplier",
      entityType: "supplier",
      entityId: s.id,
      operation: "update",
      dedupeKey: `erp:backfill:supplier:${dealerId}:${s.id}`,
    });
  }
  const openPos = await db
    .select({ id: purchaseOrdersTable.id })
    .from(purchaseOrdersTable)
    .where(
      and(
        eq(purchaseOrdersTable.dealerId, dealerId),
        inArray(purchaseOrdersTable.status, [
          "draft",
          "ordered",
          "partially_received",
        ]),
      ),
    );
  for (const po of openPos) {
    await enqueueErpnextSync({
      dealerId,
      doctype: "Purchase Order",
      entityType: "purchase_order",
      entityId: po.id,
      operation: "update",
      dedupeKey: `erp:backfill:po:${dealerId}:${po.id}`,
    });
  }
  return {
    parts: parts.length,
    suppliers: suppliers.length,
    purchaseOrders: openPos.length,
  };
}

// ————————————————————————— registration —————————————————————————

let registered = false;

export function registerErpnextPartsSync(): void {
  if (registered) return;
  registered = true;
  registerErpnextSyncHandler("Item", itemHandler);
  registerErpnextSyncHandler("Supplier", supplierHandler);
  registerErpnextSyncHandler("Stock Entry", stockEntryHandler);
  registerErpnextSyncHandler("Purchase Order", purchaseOrderHandler);
  registerErpnextSyncHandler("Purchase Receipt", purchaseReceiptHandler);
  registerErpnextInboundHandler("Stock Reconciliation", inboundStockReconciliation);
  registerErpnextInboundHandler("Stock Entry", inboundStockEntry);
  logger.info("ERPNext parts & purchasing sync registered");
}
