import { and, eq, isNull, sql, asc, gt } from "drizzle-orm";
import {
  db, partsTable, inventoryLocationsTable as locations, inventoryBinsTable as bins,
  inventoryLevelsTable as levels, inventoryTransactionsTable as ledger,
  inventoryCostLayersTable as layers, inventoryCostConsumptionsTable as consumptions,
  inventoryHoldsTable as holds, inventoryCycleCountsTable as counts,
  inventoryCycleCountLinesTable as countLines,
  partPricingPoliciesTable as policies,
} from "@workspace/db";

export type InventoryTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Scope = { dealerId: number; partId: number; locationId?: number; binId?: number | null };
export type StockMovement = Scope & {
  type: "receipt" | "issue" | "transfer" | "adjustment" | "cycle_count" | "return" | "opening";
  quantityDelta: number; referenceType: string; referenceId: string; unitCost?: number;
  nonSellableDelta?: number; createdBy?: number | null; idempotencyKey?: string; notes?: string;
  allowDuringCount?: boolean;
};
function integer(value: number, label: string) {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be an integer`);
}
function scopeWhere(table: typeof levels | typeof layers, s: Required<Scope>) {
  return and(eq(table.dealerId, s.dealerId), eq(table.partId, s.partId),
    eq(table.locationId, s.locationId), s.binId == null ? isNull(table.binId) : eq(table.binId, s.binId));
}

/** All mutation callers must supply a transaction. Part row is the shared lock
 * across locations, holds, FIFO layers and compatibility aggregate stock. */
export async function ensureInventory(tx: InventoryTx, dealerId: number, partId: number) {
  const [part] = await tx.select().from(partsTable).where(and(eq(partsTable.id, partId), eq(partsTable.dealerId, dealerId))).for("update");
  if (!part) throw new Error("Part not found in this dealership");
  await tx.insert(locations).values({ dealerId, name: "Main warehouse", isDefault: true }).onConflictDoNothing();
  const [location] = await tx.select().from(locations).where(and(eq(locations.dealerId, dealerId), eq(locations.isDefault, true)));
  if (!location) throw new Error("Default inventory location missing; rename conflicting Main warehouse location");
  if (!part.inventoryInitializedAt) {
    if (part.stock < 0) throw new Error("Legacy stock is negative; reconcile before inventory adoption");
    const [existing] = await tx.select().from(levels).where(and(eq(levels.dealerId, dealerId), eq(levels.partId, partId))).limit(1);
    if (existing) throw new Error("Inventory levels exist without initialization marker; reconciliation required");
    await tx.insert(levels).values({ dealerId, partId, locationId: location.id, quantityOnHand: part.stock, averageUnitCost: part.unitCost });
    if (part.stock > 0) {
      const [entry] = await tx.insert(ledger).values({
        dealerId, partId, locationId: location.id, type: "opening", quantityDelta: part.stock,
        referenceType: "legacy_opening", referenceId: String(partId),
        unitCostAtTransaction: part.unitCost, valueDelta: part.stock * part.unitCost,
        idempotencyKey: `legacy-opening:${partId}`, notes: "Opening balance adopted at current recorded cost; historical FIFO unavailable",
      }).returning();
      await tx.insert(layers).values({ dealerId, partId, locationId: location.id, receiptTransactionId: entry.id,
        quantityReceived: part.stock, quantityRemaining: part.stock, unitCost: part.unitCost });
    }
    await tx.update(partsTable).set({ inventoryInitializedAt: new Date() }).where(eq(partsTable.id, partId));
  }
  return { part, location };
}
/** Validate a dealership's active storage pair and record a zero-stock assignment. */
export async function assignPartStorage(tx: InventoryTx, dealerId: number, partId: number, locationId: number, binId: number) {
  const [location] = await tx.select({ id: locations.id }).from(locations)
    .where(and(eq(locations.id, locationId), eq(locations.dealerId, dealerId), eq(locations.active, true))).for("share");
  if (!location) throw Object.assign(new Error("Active inventory location not found in this dealership"), { status: 404 });
  const [bin] = await tx.select({ id: bins.id }).from(bins)
    .where(and(eq(bins.id, binId), eq(bins.locationId, locationId), eq(bins.dealerId, dealerId), eq(bins.active, true))).for("share");
  if (!bin) throw Object.assign(new Error("Active bin not found at this dealership location"), { status: 404 });
  await ensureInventory(tx, dealerId, partId);
  await tx.insert(levels).values({ dealerId, partId, locationId, binId }).onConflictDoNothing();
}
async function resolveLevel(tx: InventoryTx, input: Scope) {
  const initialized = await ensureInventory(tx, input.dealerId, input.partId);
  const scope: Required<Scope> = { ...input, locationId: input.locationId ?? initialized.location.id, binId: input.binId ?? null };
  const [location] = await tx.select().from(locations).where(and(eq(locations.id, scope.locationId), eq(locations.dealerId, scope.dealerId), eq(locations.active, true))).for("share");
  if (!location) throw new Error("Active inventory location not found in this dealership");
  if (scope.binId != null) {
    const [bin] = await tx.select().from(bins).where(and(eq(bins.id, scope.binId), eq(bins.dealerId, scope.dealerId), eq(bins.locationId, scope.locationId), eq(bins.active, true))).for("share");
    if (!bin) throw new Error("Active bin not found at this dealership location");
  }
  await tx.insert(levels).values({ ...scope, averageUnitCost: initialized.part.unitCost }).onConflictDoNothing();
  const [level] = await tx.select().from(levels).where(scopeWhere(levels, scope)).for("update");
  return { ...initialized, scope, level };
}

export async function moveStock(tx: InventoryTx, input: StockMovement) {
  integer(input.quantityDelta, "Quantity");
  const nsDelta = input.nonSellableDelta ?? 0;
  integer(nsDelta, "Non-sellable quantity");
  if (input.quantityDelta === 0 && nsDelta === 0) throw new Error("Stock movement must change quantity");
  const { part, scope, level } = await resolveLevel(tx, input);
  if (input.idempotencyKey) {
    const [existing] = await tx.select().from(ledger).where(and(eq(ledger.dealerId, input.dealerId), eq(ledger.idempotencyKey, input.idempotencyKey)));
    if (existing) {
      if (existing.partId !== input.partId || existing.locationId !== scope.locationId || existing.binId !== scope.binId ||
          existing.quantityDelta !== input.quantityDelta || existing.nonSellableDelta !== nsDelta ||
          existing.type !== input.type || existing.referenceType !== input.referenceType || existing.referenceId !== input.referenceId) {
        throw new Error("Idempotency key already used for a different stock movement");
      }
      return existing;
    }
  }
  if (!input.allowDuringCount) {
    const active = await tx.select({ id: counts.id }).from(countLines).innerJoin(counts, eq(countLines.cycleCountId, counts.id))
      .where(and(eq(counts.dealerId, input.dealerId), eq(countLines.dealerId, input.dealerId),
        eq(counts.locationId, scope.locationId), eq(countLines.partId, input.partId),
        scope.binId == null ? isNull(countLines.binId) : eq(countLines.binId, scope.binId),
        sql`${counts.status} in ('in_progress','pending_approval')`)).limit(1);
    if (active.length) throw new Error("This inventory is in a cycle count; complete or cancel the count first");
  }
  const onHand = level.quantityOnHand + input.quantityDelta;
  const nonSellable = level.quantityNonSellable + nsDelta;
  if (onHand < 0 || nonSellable < 0 || nonSellable > onHand) throw new Error("Insufficient physical inventory");
  if (input.quantityDelta < 0 && onHand - nonSellable < level.quantityReserved) throw new Error("Insufficient available inventory; stock is reserved");
  if (Math.abs(nsDelta) > Math.abs(input.quantityDelta) || (nsDelta && Math.sign(nsDelta) !== Math.sign(input.quantityDelta))) {
    throw new Error("Non-sellable delta must be part of the physical movement");
  }
  let unitCost = input.unitCost ?? level.averageUnitCost;
  if (!Number.isFinite(unitCost) || unitCost < 0) throw new Error("Unit cost must be finite and nonnegative");
  const takes: { layer: typeof layers.$inferSelect; quantity: number }[] = [];
  let valueDelta = input.quantityDelta * unitCost;
  if (input.quantityDelta < 0) {
    const available = await tx.select().from(layers).where(and(scopeWhere(layers, scope), gt(layers.quantityRemaining, 0))).orderBy(asc(layers.createdAt), asc(layers.id)).for("update");
    for (const damaged of [false, true]) {
      let needed = damaged ? -nsDelta : -input.quantityDelta + nsDelta;
      for (const layer of available.filter(l => l.nonSellable === damaged)) {
        if (needed <= 0) break;
        const quantity = Math.min(needed, layer.quantityRemaining);
        takes.push({ layer, quantity }); needed -= quantity;
      }
      if (needed > 0) throw new Error("Cost layers do not reconcile to physical stock");
    }
    const cost = part.costingMethod === "fifo"
      ? takes.reduce((sum, take) => sum + take.quantity * take.layer.unitCost, 0)
      : -input.quantityDelta * level.averageUnitCost;
    valueDelta = -cost;
    unitCost = cost / -input.quantityDelta;
  }
  const [entry] = await tx.insert(ledger).values({
    ...scope, type: input.type, quantityDelta: input.quantityDelta, nonSellableDelta: nsDelta,
    referenceType: input.referenceType, referenceId: input.referenceId, unitCostAtTransaction: unitCost, valueDelta,
    createdBy: input.createdBy, idempotencyKey: input.idempotencyKey, notes: input.notes,
  }).returning();
  for (const take of takes) {
    await tx.update(layers).set({ quantityRemaining: take.layer.quantityRemaining - take.quantity }).where(eq(layers.id, take.layer.id));
    await tx.insert(consumptions).values({ dealerId: input.dealerId, layerId: take.layer.id, transactionId: entry.id,
      quantity: take.quantity, unitCost: part.costingMethod === "fifo" ? take.layer.unitCost : unitCost });
  }
  if (input.quantityDelta > 0) {
    for (const damaged of [false, true]) {
      const quantity = damaged ? nsDelta : input.quantityDelta - nsDelta;
      if (quantity > 0) await tx.insert(layers).values({ ...scope, receiptTransactionId: entry.id, quantityReceived: quantity,
        quantityRemaining: quantity, unitCost, nonSellable: damaged });
    }
  }
  const averageUnitCost = onHand > 0 ? Math.max(0, (level.quantityOnHand * level.averageUnitCost + valueDelta) / onHand) : 0;
  await tx.update(levels).set({ quantityOnHand: onHand, quantityNonSellable: nonSellable, averageUnitCost, updatedAt: new Date() }).where(eq(levels.id, level.id));
  const [aggregate] = await tx.select({ stock: sql<number>`coalesce(sum(${levels.quantityOnHand}),0)::integer`,
    value: sql<number>`coalesce(sum(${levels.quantityOnHand} * ${levels.averageUnitCost}),0)::double precision` })
    .from(levels).where(and(eq(levels.dealerId, input.dealerId), eq(levels.partId, input.partId)));
  await tx.update(partsTable).set({ stock: aggregate.stock, unitCost: aggregate.stock > 0 ? aggregate.value / aggregate.stock : part.unitCost, updatedAt: new Date() })
    .where(and(eq(partsTable.id, input.partId), eq(partsTable.dealerId, input.dealerId)));
  return entry;
}

export async function createHold(tx: InventoryTx, input: Scope & {
  quantity: number; referenceType: string; referenceId: string; createdBy?: number | null; expiresAt?: Date;
}) {
  integer(input.quantity, "Hold quantity");
  if (input.quantity <= 0) throw new Error("Hold quantity must be positive");
  const { scope, level } = await resolveLevel(tx, input);
  const [policy] = await tx.select().from(policies).where(and(eq(policies.dealerId, input.dealerId), isNull(policies.category)));
  const expiresAt = input.expiresAt ?? new Date(Date.now() + (policy?.holdExpiryDays ?? 7) * 86_400_000);
  if (!Number.isFinite(expiresAt.getTime())) throw new Error("Hold expiry must be a valid date");
  if (input.expiresAt && expiresAt.getTime() <= Date.now()) throw new Error("Hold expiry must be in the future");
  const [hold] = await tx.insert(holds).values({ ...scope, quantity: input.quantity,
    referenceType: input.referenceType, referenceId: input.referenceId, createdBy: input.createdBy,
    expiresAt, backorderRisk: level.quantityOnHand - level.quantityNonSellable - level.quantityReserved < input.quantity }).returning();
  await tx.update(levels).set({ quantityReserved: level.quantityReserved + input.quantity, updatedAt: new Date() }).where(eq(levels.id, level.id));
  return hold;
}
async function lockHold(tx: InventoryTx, dealerId: number, holdId: number) {
  const [candidate] = await tx.select().from(holds).where(and(eq(holds.id, holdId), eq(holds.dealerId, dealerId)));
  if (!candidate) throw new Error("Inventory hold not found in this dealership");
  const resolved = await resolveLevel(tx, candidate);
  const [hold] = await tx.select().from(holds).where(and(eq(holds.id, holdId), eq(holds.dealerId, dealerId))).for("update");
  return { ...resolved, hold };
}
export async function releaseHold(tx: InventoryTx, dealerId: number, holdId: number) {
  const { hold, level } = await lockHold(tx, dealerId, holdId);
  if (hold.status !== "active") return hold;
  await tx.update(levels).set({ quantityReserved: level.quantityReserved - hold.quantity, updatedAt: new Date() }).where(eq(levels.id, level.id));
  const [result] = await tx.update(holds).set({ status: "released", releasedAt: new Date() }).where(eq(holds.id, hold.id)).returning();
  return result;
}
export async function consumeHold(tx: InventoryTx, dealerId: number, holdId: number,
  issue: { referenceType?: string; referenceId?: string; createdBy?: number | null; idempotencyKey?: string } = {}) {
  const { hold, level } = await lockHold(tx, dealerId, holdId);
  if (hold.status === "consumed") {
    const [entry] = await tx.select().from(ledger).where(and(eq(ledger.dealerId, dealerId), eq(ledger.idempotencyKey, `hold-consume:${hold.id}`)));
    if (!entry) throw new Error("Consumed hold has no issue ledger entry");
    return entry;
  }
  if (hold.status !== "active") throw new Error("Released hold cannot be consumed");
  await tx.update(levels).set({ quantityReserved: level.quantityReserved - hold.quantity, updatedAt: new Date() }).where(eq(levels.id, level.id));
  const entry = await moveStock(tx, { dealerId, partId: hold.partId, locationId: hold.locationId, binId: hold.binId,
    type: "issue", quantityDelta: -hold.quantity, referenceType: issue.referenceType ?? hold.referenceType,
    referenceId: issue.referenceId ?? hold.referenceId, createdBy: issue.createdBy, idempotencyKey: `hold-consume:${hold.id}` });
  await tx.update(holds).set({ status: "consumed", releasedAt: new Date() }).where(eq(holds.id, hold.id));
  return entry;
}