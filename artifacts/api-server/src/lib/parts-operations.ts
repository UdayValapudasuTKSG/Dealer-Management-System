import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import {
  db, partsTable, suppliersTable, purchaseOrdersTable, purchaseOrderLinesTable,
  inventoryLevelsTable, inventoryLocationsTable, inventoryBinsTable, inventoryTransactionsTable,
  inventoryHoldsTable, inventoryCycleCountsTable, inventoryCycleCountLinesTable,
  partNotificationDeliveriesTable, notificationsTable, auditLogsTable,
  jobCardsTable, jobCardPartsTable, dealerUsersTable, usersTable, quotesTable,
} from "@workspace/db";
import { ensureInventory, moveStock, releaseHold } from "./parts-inventory";
import { resolveDealerSmtp, sanitizeSmtpError } from "./smtp-connection";
import { sendPartsAdvisorSms } from "./parts-operations-sms";
import { dealerTimezone, zonedDayKey } from "./timezone";
import { enqueueStockEntrySync } from "./erpnext/parts-sync";

export type PartsTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Only call after the enclosing stock transaction has COMMITTED. AURA transfers
 * are net zero in the single configured ERP warehouse, and PO receipts use only
 * Purchase Receipt sync. Neither belongs in this outbound Stock Entry path.
 */
export function enqueueOperationalStockSync(movement: typeof inventoryTransactionsTable.$inferSelect) {
  if (!["issue", "adjustment", "cycle_count"].includes(movement.type) || !movement.quantityDelta) return;
  const options: Parameters<typeof enqueueStockEntrySync>[0] & { unitCost: number } = {
    dealerId: movement.dealerId,
    partId: movement.partId,
    qty: Math.abs(movement.quantityDelta),
    direction: movement.quantityDelta > 0 ? "in" : "out",
    entityType: "inventory_transaction",
    entityId: movement.id,
    unitCost: movement.unitCostAtTransaction,
    remark: `AURA inventory ledger #${movement.id} — ${movement.type}; posted unit cost ${movement.unitCostAtTransaction}`,
    dedupeKey: `erp:se:inventory-ledger:${movement.dealerId}:${movement.id}`,
  };
  enqueueStockEntrySync(options);
}
export class PartsOperationError extends Error {
  constructor(message: string, public status = 409) { super(message); }
}
export function demand(value: unknown, message: string, status = 409): asserts value {
  if (!value) throw new PartsOperationError(message, status);
}
export async function owned(tx: any, table: any, dealerId: number, id: number, lock = false): Promise<any> {
  let query = tx.select().from(table).where(and(eq(table.dealerId, dealerId), eq(table.id, id)));
  if (lock) query = query.for("update");
  const [row] = await query;
  demand(row, "Record not found", 404);
  return row;
}
export async function operationAudit(tx: PartsTx, dealerId: number, actorId: number | null, entityType: string, id: number, summary: string, details: Record<string, unknown> = {}) {
  await tx.insert(auditLogsTable).values({ dealerId, actorUserId: actorId, module: "parts", action: "update", entityType, entityId: String(id), summary, details });
}
// A dealer-local procurement mutex serializes generation and supplier approval.
// It does not block unrelated dealers or stock transactions.
export async function procurementLock(tx: PartsTx, dealerId: number) {
  await tx.execute(sql`select pg_advisory_xact_lock(73142, ${dealerId})`);
}
export async function validateLocation(tx: any, dealerId: number, locationId: number, binId?: number | null) {
  const location = await owned(tx, inventoryLocationsTable, dealerId, locationId);
  demand(location.active, "Location is inactive");
  if (binId != null) {
    const bin = await owned(tx, inventoryBinsTable, dealerId, binId);
    demand(bin.active && bin.locationId === locationId, "Bin is inactive or belongs to another location");
  }
  return location;
}

export async function generateLowStockOrders(dealerId: number, actorId: number | null, locationId?: number) {
  return db.transaction(async tx => {
    await procurementLock(tx, dealerId);
    if (locationId) await validateLocation(tx, dealerId, locationId);
    const parts = await tx.select().from(partsTable).where(and(eq(partsTable.dealerId, dealerId), eq(partsTable.active, true))).orderBy(partsTable.id);
    for (const part of parts) await ensureInventory(tx, dealerId, part.id);
    const levels = await tx.select().from(inventoryLevelsTable).where(and(eq(inventoryLevelsTable.dealerId, dealerId), locationId ? eq(inventoryLevelsTable.locationId, locationId) : undefined));
    const pending = await tx.select({ partId: purchaseOrderLinesTable.partId, locationId: purchaseOrdersTable.locationId, quantity: purchaseOrderLinesTable.quantity, received: purchaseOrderLinesTable.qtyReceived })
      .from(purchaseOrderLinesTable).innerJoin(purchaseOrdersTable, and(eq(purchaseOrdersTable.id, purchaseOrderLinesTable.purchaseOrderId), eq(purchaseOrdersTable.dealerId, dealerId)))
      .where(and(eq(purchaseOrderLinesTable.dealerId, dealerId), inArray(purchaseOrdersTable.status, ["draft", "ordered", "sent", "partially_received"])));
    const locations = await tx.select().from(inventoryLocationsTable).where(and(eq(inventoryLocationsTable.dealerId, dealerId), eq(inventoryLocationsTable.active, true)));
    const groups = new Map<string, { part: typeof parts[number]; locationId: number; quantity: number; supplierId: number | null }[]>();
    for (const part of parts) {
      for (const location of locations.filter(l => !locationId || l.id === locationId)) {
        const scoped = levels.filter(l => l.partId === part.id && l.locationId === location.id);
        if (!scoped.length) continue; // No invented assortment at a location.
        const available = scoped.reduce((n, l) => n + l.quantityOnHand - l.quantityReserved - l.quantityNonSellable, 0);
        if (available > part.reorderLevel) continue;
        const incoming = pending.filter(p => p.partId === part.id && p.locationId === location.id).reduce((n, p) => n + Math.max(0, p.quantity - p.received), 0);
        const quantity = Math.max(0, part.reorderMax - available - incoming);
        if (!quantity) continue;
        let supplierId = part.supplierId;
        if (supplierId) {
          const supplier = await owned(tx, suppliersTable, dealerId, supplierId);
          if (supplier.status !== "active") supplierId = null;
        }
        const key = `${location.id}:${supplierId ?? "unassigned"}`;
        groups.set(key, [...(groups.get(key) ?? []), { part, locationId: location.id, quantity, supplierId }]);
      }
    }
    const orders = [];
    for (const lines of groups.values()) {
      const first = lines[0]!;
      const [po] = await tx.insert(purchaseOrdersTable).values({ dealerId, locationId: first.locationId, supplierId: first.supplierId, source: "low_stock_alert", status: "draft", needsSupplier: !first.supplierId, createdBy: actorId }).returning();
      const inserted = await tx.insert(purchaseOrderLinesTable).values(lines.map(l => ({ dealerId, purchaseOrderId: po!.id, partId: l.part.id, partName: l.part.name, quantity: l.quantity, unitCost: l.part.unitCost }))).returning();
      orders.push({ ...po, lines: inserted });
    }
    return { orders };
  });
}

export async function createSpecialOrder(dealerId: number, actorId: number, input: { partId: number; locationId: number; quantity: number; referenceType: "job" | "estimate"; referenceId: number; advisorId: number; idempotencyKey: string }) {
  return db.transaction(async tx => {
    await procurementLock(tx, dealerId);
    const reference = `special:${input.idempotencyKey}`;
    const [existing] = await tx.select().from(purchaseOrdersTable).where(and(eq(purchaseOrdersTable.dealerId, dealerId), eq(purchaseOrdersTable.reference, reference)));
    if (existing) {
      const lines = await tx.select().from(purchaseOrderLinesTable).where(and(eq(purchaseOrderLinesTable.dealerId, dealerId), eq(purchaseOrderLinesTable.purchaseOrderId, existing.id)));
      demand(existing.source === "special_order" && existing.locationId === input.locationId && existing.advisorId === input.advisorId && (input.referenceType === "job" ? existing.jobCardId : existing.estimateId) === input.referenceId && lines.length === 1 && lines[0]!.partId === input.partId && lines[0]!.quantity === input.quantity, "Idempotency key already used for another request");
      return { ...existing, lines };
    }
    await validateLocation(tx, dealerId, input.locationId);
    // Service estimates are versions of the existing job card, not a second stock entity.
    await owned(tx, jobCardsTable, dealerId, input.referenceId);
    const [member] = await tx.select().from(dealerUsersTable).innerJoin(usersTable, eq(usersTable.id, dealerUsersTable.userId))
      .where(and(eq(dealerUsersTable.dealerId, dealerId), eq(dealerUsersTable.userId, input.advisorId), eq(usersTable.status, "active")));
    demand(member, "Advisor is not an active member of this dealer", 400);
    const part = await owned(tx, partsTable, dealerId, input.partId);
    let supplierId = part.supplierId;
    if (supplierId && (await owned(tx, suppliersTable, dealerId, supplierId)).status !== "active") supplierId = null;
    const [po] = await tx.insert(purchaseOrdersTable).values({ dealerId, supplierId, locationId: input.locationId, source: "special_order", status: "draft", needsSupplier: !supplierId, createdBy: actorId, advisorId: input.advisorId, jobCardId: input.referenceType === "job" ? input.referenceId : null, estimateId: input.referenceType === "estimate" ? input.referenceId : null, reference }).returning();
    const lines = await tx.insert(purchaseOrderLinesTable).values({ dealerId, purchaseOrderId: po!.id, partId: part.id, partName: part.name, quantity: input.quantity, unitCost: part.unitCost, jobCardId: input.referenceType === "job" ? input.referenceId : null }).returning();
    return { ...po, lines };
  });
}

/** Parent-first locks serialize hold creation/consumption with quote supersession
 * and job cancellation. Missing/deleted references cannot retain reservations. */
export async function holdReferenceIsTerminal(tx: PartsTx, dealerId: number, referenceType: string, referenceId: string, now = new Date()) {
  if (!["quote", "job", "estimate"].includes(referenceType)) return false;
  const id = Number(referenceId);
  if (!Number.isSafeInteger(id) || id <= 0) return true;
  if (referenceType !== "quote") {
    const [job] = await tx.select().from(jobCardsTable).where(and(
      eq(jobCardsTable.id, id), eq(jobCardsTable.dealerId, dealerId),
    )).for("update");
    return !job || ["cancelled", "closed"].includes(job.status);
  }
  const [quote] = await tx.select().from(quotesTable).where(and(
    eq(quotesTable.id, id), eq(quotesTable.dealerId, dealerId),
  )).for("update");
  if (!quote || quote.status !== "current") return true;
  // Quote validity is an inclusive dealer-local calendar date, stored by the
  // existing generator as "Month D, YYYY" (legacy ISO dates are also supported).
  const months = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  const long = /^([A-Za-z]+) (\d{1,2}), (\d{4})$/.exec(quote.validUntil);
  const month = long ? months.indexOf(long[1]) + 1 : 0;
  const validDay = /^\d{4}-\d{2}-\d{2}$/.test(quote.validUntil) ? quote.validUntil
    : long && month ? `${long[3]}-${String(month).padStart(2, "0")}-${long[2].padStart(2, "0")}` : null;
  return validDay != null && validDay < zonedDayKey(now, await dealerTimezone(dealerId));
}

export async function expirePartsHolds(dealerId: number, now = new Date()) {
  // Include non-expired holds so superseded/cancelled/expired quotes release
  // on the next scheduled sweep, rather than waiting out the seven-day TTL.
  const holds = await db.select().from(inventoryHoldsTable).where(and(eq(inventoryHoldsTable.dealerId, dealerId), eq(inventoryHoldsTable.status, "active"))).orderBy(inventoryHoldsTable.partId, inventoryHoldsTable.id);
  let released = 0;
  // Separate transactions avoid holding several job-card locks across a dealer.
  for (const hold of holds) {
    const changed = await db.transaction(async tx => {
      const terminal = await holdReferenceIsTerminal(tx, dealerId, hold.referenceType, hold.referenceId, now);
      const current = await owned(tx, inventoryHoldsTable, dealerId, hold.id);
      if (current.status !== "active" || (!terminal && new Date(current.expiresAt) > now)) return false;
      const result = await releaseOperationalHold(tx, dealerId, hold.id);
      return result.status === "released";
    });
    if (changed) released++;
  }
  return { released };
}

/** Clear the live job-line pointer when a hold is released/expired, so later
 * billing uses the central direct-issue path instead of consuming a dead hold.
 * Lock the parent job first, matching service's stock-write ordering.
 */
export async function releaseOperationalHold(tx: PartsTx, dealerId: number, holdId: number) {
  const hold = await owned(tx, inventoryHoldsTable, dealerId, holdId);
  const [line] = await tx.select().from(jobCardPartsTable).where(and(eq(jobCardPartsTable.dealerId, dealerId), eq(jobCardPartsTable.inventoryHoldId, holdId)));
  if (line) await owned(tx, jobCardsTable, dealerId, line.jobCardId, true);
  const result = await releaseHold(tx, dealerId, holdId);
  if (line && result.status === "released") {
    await tx.update(jobCardPartsTable).set({ inventoryHoldId: null }).where(and(eq(jobCardPartsTable.dealerId, dealerId), eq(jobCardPartsTable.id, line.id), eq(jobCardPartsTable.inventoryHoldId, hold.id)));
  }
  return result;
}

export async function startCycleCount(dealerId: number, actorId: number, input: { locationId: number; binId?: number; category?: string }) {
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(73143, ${dealerId})`);
    await validateLocation(tx, dealerId, input.locationId, input.binId);
    const selected = await tx.select({ partId: inventoryLevelsTable.partId }).from(inventoryLevelsTable)
      .innerJoin(partsTable, and(eq(partsTable.id, inventoryLevelsTable.partId), eq(partsTable.dealerId, dealerId)))
      .where(and(eq(inventoryLevelsTable.dealerId, dealerId), eq(inventoryLevelsTable.locationId, input.locationId), input.binId ? eq(inventoryLevelsTable.binId, input.binId) : undefined, input.category ? eq(partsTable.category, input.category) : undefined))
      .orderBy(inventoryLevelsTable.partId);
    const partIds = [...new Set(selected.map(p => p.partId))];
    // Same part-first locks as central writer: snapshots cannot race issues.
    // Do not lock every part in the dealer for a location/bin-scoped count.
    demand(partIds.length, "No inventory levels in this count scope", 400);
    for (const partId of partIds) await ensureInventory(tx, dealerId, partId);
    const scoped = await tx.select().from(inventoryLevelsTable).where(and(eq(inventoryLevelsTable.dealerId, dealerId), eq(inventoryLevelsTable.locationId, input.locationId), inArray(inventoryLevelsTable.partId, partIds), input.binId ? eq(inventoryLevelsTable.binId, input.binId) : undefined)).orderBy(inventoryLevelsTable.partId).for("update");
    demand(scoped.length, "No inventory levels in this count scope", 400);
    const active = await tx.select({ partId: inventoryCycleCountLinesTable.partId, binId: inventoryCycleCountLinesTable.binId })
      .from(inventoryCycleCountLinesTable).innerJoin(inventoryCycleCountsTable, and(eq(inventoryCycleCountsTable.id, inventoryCycleCountLinesTable.cycleCountId), eq(inventoryCycleCountsTable.dealerId, dealerId)))
      .where(and(eq(inventoryCycleCountLinesTable.dealerId, dealerId), eq(inventoryCycleCountsTable.locationId, input.locationId), inArray(inventoryCycleCountsTable.status, ["in_progress", "pending_approval"])));
    demand(!scoped.some(l => active.some(a => a.partId === l.partId && a.binId === l.binId)), "A count already locks a selected level");
    const [count] = await tx.insert(inventoryCycleCountsTable).values({ dealerId, ...input, startedBy: actorId }).returning();
    const lines = await tx.insert(inventoryCycleCountLinesTable).values(scoped.map(l => ({ dealerId, cycleCountId: count!.id, partId: l.partId, binId: l.binId, expectedQty: l.quantityOnHand }))).returning();
    return { ...count, lines };
  });
}
export async function approveCycleCount(dealerId: number, actorId: number, id: number) {
  const result = await db.transaction(async tx => {
    const count = await owned(tx, inventoryCycleCountsTable, dealerId, id, true);
    if (count.status === "completed") return count;
    demand(["in_progress", "pending_approval"].includes(count.status), "Count cannot be approved");
    const lines = await tx.select().from(inventoryCycleCountLinesTable).where(and(eq(inventoryCycleCountLinesTable.dealerId, dealerId), eq(inventoryCycleCountLinesTable.cycleCountId, id))).orderBy(inventoryCycleCountLinesTable.partId);
    demand(lines.length && lines.every(l => l.countedQty !== null), "Enter every counted quantity before approval");
    for (const line of lines) {
      const variance = line.countedQty! - line.expectedQty;
      let transactionId: number | null = null;
      if (variance) {
        const movement = await moveStock(tx, { dealerId, partId: line.partId, locationId: count.locationId, binId: line.binId, type: "cycle_count", quantityDelta: variance, referenceType: "cycle_count", referenceId: String(id), createdBy: actorId, idempotencyKey: `cycle:${id}:${line.id}`, allowDuringCount: true, notes: "Manager-approved count variance" });
        transactionId = movement.id;
      }
      await tx.update(inventoryCycleCountLinesTable).set({ variance, approvedBy: actorId, transactionId }).where(and(eq(inventoryCycleCountLinesTable.dealerId, dealerId), eq(inventoryCycleCountLinesTable.id, line.id)));
    }
    const [result] = await tx.update(inventoryCycleCountsTable).set({ status: "completed", approvedBy: actorId, completedAt: new Date() }).where(and(eq(inventoryCycleCountsTable.dealerId, dealerId), eq(inventoryCycleCountsTable.id, id))).returning();
    await operationAudit(tx, dealerId, actorId, "cycle_count", id, "Approved inventory count", { lines: lines.map(l => ({ id: l.id, expected: l.expectedQty, counted: l.countedQty })) });
    return result;
  });
  // Reconstruct committed movement rows even on an approval retry. ERP's stable
  // ledger-id dedupe keys prevent reposting while allowing enqueue recovery.
  const movements = await db.select({ movement: inventoryTransactionsTable })
    .from(inventoryCycleCountLinesTable)
    .innerJoin(inventoryTransactionsTable, and(eq(inventoryTransactionsTable.id, inventoryCycleCountLinesTable.transactionId), eq(inventoryTransactionsTable.dealerId, dealerId)))
    .where(and(eq(inventoryCycleCountLinesTable.dealerId, dealerId), eq(inventoryCycleCountLinesTable.cycleCountId, id)));
  for (const { movement } of movements) enqueueOperationalStockSync(movement);
  return result;
}

/** Call INSIDE receiving transaction, after qtyReceived changes. Never sends. */
export async function postPartsReceipt(tx: PartsTx, input: { dealerId: number; purchaseOrderId: number; actorId?: number }) {
  const po = await owned(tx, purchaseOrdersTable, input.dealerId, input.purchaseOrderId);
  if (po.source !== "special_order" || !po.advisorId) return;
  const lines = await tx.select().from(purchaseOrderLinesTable).where(and(eq(purchaseOrderLinesTable.dealerId, input.dealerId), eq(purchaseOrderLinesTable.purchaseOrderId, po.id)));
  if (!lines.some(l => l.qtyReceived > 0)) return;
  const receiptVersion = lines.map(l => `${l.id}:${l.qtyReceived}`).sort().join(",");
  for (const channel of ["internal", "sms"]) {
    await tx.insert(partNotificationDeliveriesTable).values({ dealerId: input.dealerId, recipientId: po.advisorId, channel, type: "special_order.received", referenceType: "purchase_order", referenceId: `${po.id}:${receiptVersion}`, payload: { purchaseOrderId: po.id, jobCardId: po.jobCardId, estimateId: po.estimateId, title: "Special-order parts received", body: `Purchase order #${po.id} has received parts. Review the linked ${po.jobCardId ? "job" : "estimate"}.` } }).onConflictDoNothing();
  }
}

const escapeHtml = (s: unknown) => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export async function queueSupplierEmail(dealerId: number, actorId: number, id: number, resend: boolean) {
  return db.transaction(async tx => {
    await procurementLock(tx, dealerId);
    const po = await owned(tx, purchaseOrdersTable, dealerId, id, true);
    demand(["draft", "ordered", "sent", "partially_received"].includes(po.status), "This PO cannot be sent");
    demand(po.supplierId, "Assign a supplier before sending", 400);
    const supplier = await owned(tx, suppliersTable, dealerId, po.supplierId);
    demand(supplier.status === "active" && supplier.email, "Active supplier email is required", 400);
    const prior = await tx.select().from(partNotificationDeliveriesTable).where(and(eq(partNotificationDeliveriesTable.dealerId, dealerId), eq(partNotificationDeliveriesTable.type, "supplier.po"), eq(partNotificationDeliveriesTable.referenceType, "purchase_order"), sql`${partNotificationDeliveriesTable.payload}->>'purchaseOrderId' = ${String(id)}`));
    demand(!prior.some(r => ["pending", "sending"].includes(r.status)), "Supplier email already queued");
    demand(!prior.length || resend, "Explicit resend confirmation required");
    const lines = await tx.select().from(purchaseOrderLinesTable).where(and(eq(purchaseOrderLinesTable.dealerId, dealerId), eq(purchaseOrderLinesTable.purchaseOrderId, id)));
    demand(lines.length, "PO has no lines", 400);
    const html = `<h1>Purchase order #${id}</h1><p>${escapeHtml(supplier.name)}</p><table><thead><tr><th>Part</th><th>Qty</th><th>Unit cost</th></tr></thead><tbody>${lines.map(l => `<tr><td>${escapeHtml(l.partName)}</td><td>${l.quantity}</td><td>${l.unitCost.toFixed(2)}</td></tr>`).join("")}</tbody></table>`;
    const [delivery] = await tx.insert(partNotificationDeliveriesTable).values({ dealerId, recipientId: actorId, channel: "email", type: "supplier.po", referenceType: "purchase_order", referenceId: `${id}:send:${prior.length + 1}`, payload: { purchaseOrderId: id, to: supplier.email, subject: `Purchase order #${id}`, html, approvedBy: actorId, resend } }).returning();
    await operationAudit(tx, dealerId, actorId, "purchase_order", id, resend ? "Approved supplier PO resend" : "Approved supplier PO email", { deliveryId: delivery!.id });
    return delivery;
  });
}

export type PartsDeliveryTransport = {
  email?: (dealerId: number, message: { to: string; subject: string; html: string }) => Promise<void>;
  sms?: (dealerId: number, recipientId: number, body: string) => Promise<void>;
};
/** Explicit worker entrypoint. No scheduler or real provider calls on import.
 * SMS uses the existing Twilio account only with explicit dealer sender opt-in.
 * Tests may inject transports; OUTBOX_WORKER_DISABLED disables all delivery.
 * Ambiguous 'sending' rows after a process crash are NOT auto-resubmitted.
 */
export async function sweepPartsNotifications(dealerId: number, transport: PartsDeliveryTransport = {}, limit = 25) {
  if (process.env.OUTBOX_WORKER_DISABLED === "1") return [];
  const candidates = await db.select().from(partNotificationDeliveriesTable).where(and(eq(partNotificationDeliveriesTable.dealerId, dealerId), eq(partNotificationDeliveriesTable.status, "pending"))).orderBy(partNotificationDeliveriesTable.id).limit(Math.min(100, limit));
  const results = [];
  for (const candidate of candidates) {
    const [row] = await db.update(partNotificationDeliveriesTable).set({ status: "sending", attempts: sql`${partNotificationDeliveriesTable.attempts} + 1`, errorMessage: null }).where(and(eq(partNotificationDeliveriesTable.dealerId, dealerId), eq(partNotificationDeliveriesTable.id, candidate.id), eq(partNotificationDeliveriesTable.status, "pending"))).returning();
    if (!row) continue;
    let providerAccepted = false;
    try {
      const p = row.payload;
      if (row.channel === "internal") {
        const [member] = await db.select({ id: usersTable.id }).from(dealerUsersTable).innerJoin(usersTable, eq(usersTable.id, dealerUsersTable.userId))
          .where(and(eq(dealerUsersTable.dealerId, dealerId), eq(dealerUsersTable.userId, row.recipientId), eq(usersTable.status, "active")));
        demand(member, "Advisor is no longer an active member of this dealer");
        await db.insert(notificationsTable).values({ dealerId, userId: row.recipientId, type: "system", title: String(p.title), body: String(p.body), entityType: "purchase_order", entityId: Number(p.purchaseOrderId), link: "/parts" }).onConflictDoUpdate({ target: [notificationsTable.dealerId, notificationsTable.userId, notificationsTable.type, notificationsTable.entityType, notificationsTable.entityId], targetWhere: sql`entity_type is not null and entity_id is not null`, set: { read: false, body: String(p.body), updatedAt: new Date() } });
      } else if (row.channel === "sms") {
        await (transport.sms ?? sendPartsAdvisorSms)(dealerId, row.recipientId, String(p.body));
      } else {
        const message = { to: String(p.to), subject: String(p.subject), html: String(p.html) };
        if (transport.email) await transport.email(dealerId, message);
        else {
          const smtp = await resolveDealerSmtp(dealerId);
          demand(smtp.ok, "Dealer SMTP is not configured or disabled");
          await smtp.transport.sendMail({ from: smtp.fromName ? { name: smtp.fromName, address: smtp.fromEmail } : smtp.fromEmail, replyTo: smtp.replyTo ?? undefined, ...message });
        }
      }
      providerAccepted = true;
      await db.transaction(async tx => {
        await tx.update(partNotificationDeliveriesTable).set({ status: "sent", sentAt: new Date() }).where(and(eq(partNotificationDeliveriesTable.dealerId, dealerId), eq(partNotificationDeliveriesTable.id, row.id)));
        if (row.type === "supplier.po") {
          const po = await owned(tx, purchaseOrdersTable, dealerId, Number(p.purchaseOrderId), true);
          await tx.update(purchaseOrdersTable).set({ status: po.status === "draft" ? "ordered" : po.status, sentAt: new Date(), sendCount: po.sendCount + 1 }).where(and(eq(purchaseOrdersTable.dealerId, dealerId), eq(purchaseOrdersTable.id, po.id)));
        }
      });
      results.push({ id: row.id, status: "sent" });
    } catch (error) {
      const errorMessage = error instanceof PartsOperationError || (error instanceof Error && error.name === "PartsSmsConfigurationError")
        ? error.message
        : row.channel === "sms" ? "SMS provider rejected or could not confirm the message. Check the dealer SMS setup and provider delivery logs before retrying." : sanitizeSmtpError(error).message;
      const status = providerAccepted ? "sending" : "failed";
      await db.update(partNotificationDeliveriesTable).set({ status, errorMessage: providerAccepted ? "Provider accepted message but delivery bookkeeping failed. Investigate before retrying to avoid duplicates." : errorMessage }).where(and(eq(partNotificationDeliveriesTable.dealerId, dealerId), eq(partNotificationDeliveriesTable.id, row.id)));
      results.push({ id: row.id, status });
    }
  }
  return results;
}