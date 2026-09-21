import { and, eq, lte, sql } from "drizzle-orm";
import { db, inventoryTransactionsTable, partsTable, inventoryCostLayersTable, inventoryCostConsumptionsTable } from "@workspace/db";
import { demand } from "./parts-operations";
import { replenishmentCalculation } from "./parts-operations-math";
export { replenishmentCalculation, reconciliationFlags, csv } from "./parts-operations-math";

export async function agingReport(dealerId: number, options: { locationId?: number; category?: string; thresholds: number[]; now?: Date }) {
  const now = options.now ?? new Date();
  const result = await db.execute(sql`
    select p.id as "partId", p.sku, p.name, p.category, p.status,
      l.location_id as "locationId", sum(l.quantity_on_hand)::int as quantity,
      sum(l.quantity_on_hand*l.average_unit_cost)::float8 as "currentValue",
      (select max(t.created_at) from inventory_transactions t
        where t.dealer_id=${dealerId} and t.part_id=p.id and t.location_id=l.location_id
        and t.type in ('issue','transfer')) as "lastMovementAt",
      (select min(t.created_at) from inventory_transactions t
        where t.dealer_id=${dealerId} and t.part_id=p.id and t.location_id=l.location_id) as "historyStartAt"
    from inventory_levels l join parts p on p.id=l.part_id and p.dealer_id=l.dealer_id
    where l.dealer_id=${dealerId}
      ${options.locationId ? sql`and l.location_id=${options.locationId}` : sql``}
      ${options.category ? sql`and p.category=${options.category}` : sql``}
    group by p.id,l.location_id having sum(l.quantity_on_hand)>0`);
  const rows = result.rows.map((r: any) => {
    const date = r.lastMovementAt ?? r.historyStartAt;
    const ageDays = date ? Math.max(0, Math.floor((now.getTime() - new Date(date).getTime()) / 86400000)) : null;
    const threshold = ageDays === null ? null : [...options.thresholds].reverse().find(t => ageDays >= t);
    return { ...r, ageDays, ageBasis: r.lastMovementAt ? "last_issue_or_transfer" : date ? "observed_history_start" : "unknown", bucket: ageDays === null ? "unknown" : threshold === undefined ? `<${options.thresholds[0]}` : `${threshold}+`, historicalAgeUnknown: !r.lastMovementAt };
  });
  const buckets = [...new Set(rows.map(r => r.bucket))].map(bucket => ({ bucket, quantity: rows.filter(r => r.bucket === bucket).reduce((n, r) => n + Number(r.quantity), 0), value: rows.filter(r => r.bucket === bucket).reduce((n, r) => n + Number(r.currentValue), 0) }));
  return { asOf: now.toISOString(), thresholds: options.thresholds, rows, buckets, movementPolicy: "Only issues and transfers reset age. With no outbound history, age begins at first observed ledger entry; legacy age is unknown." };
}

export async function valuationReport(dealerId: number, asOf: Date, locationId?: number) {
  demand(asOf <= new Date(), "Future valuation dates are not supported", 400);
  const txs = await db.select().from(inventoryTransactionsTable).where(and(eq(inventoryTransactionsTable.dealerId, dealerId), lte(inventoryTransactionsTable.createdAt, asOf), locationId ? eq(inventoryTransactionsTable.locationId, locationId) : undefined));
  const parts = await db.select().from(partsTable).where(eq(partsTable.dealerId, dealerId));
  const layers = await db.select().from(inventoryCostLayersTable).where(and(eq(inventoryCostLayersTable.dealerId, dealerId), lte(inventoryCostLayersTable.createdAt, asOf), locationId ? eq(inventoryCostLayersTable.locationId, locationId) : undefined));
  const consumptions = await db.select().from(inventoryCostConsumptionsTable).where(and(eq(inventoryCostConsumptionsTable.dealerId, dealerId), lte(inventoryCostConsumptionsTable.createdAt, asOf)));
  const keys = [...new Set(txs.map(t => `${t.partId}:${t.locationId}`))];
  const rows = keys.map(key => {
    const [partId, loc] = key.split(":").map(Number);
    const part = parts.find(p => p.id === partId)!;
    const history = txs.filter(t => t.partId === partId && t.locationId === loc);
    const quantity = history.reduce((n, t) => n + t.quantityDelta, 0);
    // valueDelta is the central writer's actual weighted/landed posting value.
    let value = history.reduce((n, t) => n + t.valueDelta, 0);
    if (part.costingMethod === "fifo") {
      value = layers.filter(l => l.partId === partId && l.locationId === loc).reduce((n, l) => n + (l.quantityReceived - consumptions.filter(c => c.layerId === l.id).reduce((q, c) => q + c.quantity, 0)) * l.unitCost, 0);
    }
    return { partId, sku: part.sku, name: part.name, locationId: loc, method: part.costingMethod, quantity, value, legacyOpening: history.some(t => t.type === "opening"), costBasis: part.costingMethod === "fifo" ? "dated_receipt_layers_less_dated_consumptions" : "central_ledger_value_deltas" };
  });
  const unavailable = parts.filter(p => !p.inventoryInitializedAt || p.inventoryInitializedAt > asOf).map(p => ({ partId: p.id, sku: p.sku, reason: "No reliable ledger history at requested date; historical cost has not been invented." }));
  return { asOf: asOf.toISOString(), rows, byLocation: [...new Set(rows.map(r => r.locationId))].map(locationId => ({ locationId, value: rows.filter(r => r.locationId === locationId).reduce((n, r) => n + r.value, 0) })), totalValue: rows.reduce((n, r) => n + r.value, 0), incomplete: unavailable.length > 0, unavailable };
}

export async function replenishmentReport(dealerId: number, locationId?: number) {
  const now = new Date();
  const from = new Date(now); from.setUTCFullYear(from.getUTCFullYear() - 2);
  const data = await db.execute(sql`
    select p.id as "partId",p.sku,p.name,p.reorder_level as min,p.reorder_max as max,
      s.lead_time_days as "leadTimeDays", l.location_id as "locationId",
      sum(l.quantity_on_hand-l.quantity_reserved-l.quantity_non_sellable)::int as available,
      (select coalesce(sum(pl.quantity-pl.qty_received),0) from purchase_order_lines pl
       join purchase_orders po on po.id=pl.purchase_order_id and po.dealer_id=pl.dealer_id
       where pl.dealer_id=${dealerId} and pl.part_id=p.id and po.location_id=l.location_id
       and po.status in ('draft','ordered','sent','partially_received'))::int as pending,
      (select min(t.created_at) from inventory_transactions t where t.dealer_id=${dealerId}
       and t.part_id=p.id and t.location_id=l.location_id) as "historyStart"
    from inventory_levels l join parts p on p.id=l.part_id and p.dealer_id=l.dealer_id
    left join suppliers s on s.id=p.supplier_id and s.dealer_id=p.dealer_id
    where l.dealer_id=${dealerId} and p.active
    ${locationId ? sql`and l.location_id=${locationId}` : sql``}
    group by p.id,s.lead_time_days,l.location_id`);
  const issues = await db.select().from(inventoryTransactionsTable).where(and(eq(inventoryTransactionsTable.dealerId, dealerId), eq(inventoryTransactionsTable.type, "issue"), sql`${inventoryTransactionsTable.createdAt} >= ${from}`));
  return data.rows.map((r: any) => {
    if (!r.historyStart || r.leadTimeDays == null) return { ...r, suggestedQuantity: null, reason: !r.historyStart ? "Insufficient usage history" : "Supplier lead time unavailable" };
    const start = new Date(Math.max(from.getTime(), new Date(r.historyStart).getTime()));
    const scoped = issues.filter(t => t.partId === r.partId && t.locationId === r.locationId && t.quantityDelta < 0).map(t => ({ date: t.createdAt, quantity: -t.quantityDelta }));
    if (!scoped.length) return { ...r, suggestedQuantity: null, reason: "No observed outbound issues; seasonal demand cannot be inferred" };
    return { ...r, ...replenishmentCalculation({ issues: scoped, now, historyStart: start, leadTimeDays: r.leadTimeDays, available: r.available, pending: r.pending, min: r.min, max: r.max }), dataMaturity: now.getTime() - start.getTime() >= 365 * 86400000 ? "seasonal" : "limited_history" };
  });
}
