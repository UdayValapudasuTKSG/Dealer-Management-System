import { and, eq, sql } from "drizzle-orm";
import {
  db, partsPosSettingsTable as settings, partsPosRequestsTable as requests,
  partsTable, customersTable, inventoryLevelsTable, dealersTable, erpnextSyncJobsTable,
} from "@workspace/db";
import { ensureInventory } from "./parts-inventory";
import { dealerTimezone, zonedDayKey } from "./timezone";
import { getErpnextConnection } from "./erpnext/connection";
import { defaultPosConfig, money, posConfigSchema, tenderTotal, totals, shiftAmounts,
  type PosInput, type PosConfig, type PosLine, type PosSnapshot } from "./parts-pos-policy";

export type PosTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type PosRequest = typeof requests.$inferSelect;
export async function posLock(tx: PosTx, dealerId: number) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`parts-pos:${dealerId}`}))`);
}
export async function posSettings(tx: PosTx | typeof db, dealerId: number) {
  const [row] = await tx.select().from(settings).where(eq(settings.dealerId, dealerId));
  return { row, config: row ? posConfigSchema.parse(row.config) : structuredClone(defaultPosConfig) };
}
export async function isPosDummy(dealerId: number) {
  const [d] = await db.select({ name: dealersTable.name }).from(dealersTable).where(eq(dealersTable.id, dealerId));
  return dealerId === 2 && d?.name.trim().toLowerCase() === "cam motors dummy";
}
export function source(config: PosConfig, id: string | undefined) {
  const found = config.sources.find(s => s.id === id);
  if (!found) throw new Error("Select a configured receiving/payment source");
  return found;
}
export async function posRows(tx: PosTx | typeof db, dealerId: number) {
  return tx.select().from(requests).where(eq(requests.dealerId, dealerId));
}
const reserved = (r: PosRequest) => !["rejected"].includes(r.status);
export async function buildPosSnapshot(tx: PosTx, dealerId: number, input: PosInput, config: PosConfig, excludeId?: number): Promise<PosSnapshot> {
  if (!config.enabled) throw new Error("Enable the parts POS workflow in its Finance configuration");
  if (!config.taxApproved || !config.approvalReference) throw new Error("Finance must approve the parts VAT policy and supply its reference");
  const date = zonedDayKey(new Date(), await dealerTimezone(dealerId));
  const all = (await posRows(tx, dealerId)).filter(r => r.id !== excludeId);
  const paid = tenderTotal(input.tenders);
  const conn = await getErpnextConnection(dealerId);
  if (!conn?.enabled || !conn.companyName) throw new Error("Connect the dealership's ERPNext company first");
  for (const t of input.tenders ?? []) {
    source(config, t.sourceId);
    if (money(t.amount) <= 0) throw new Error("Tender must be at least one cent");
  }
  const base: PosSnapshot = { config, date, lines: [], total: 0, net: 0, tax: 0, cost: 0,
    paid, balance: 0, customerName: input.customerName?.trim() || "Walk-in customer",
    erpSite: conn.siteUrl, erpCompany: conn.companyName };
  if (input.kind === "shift_close") {
    if (!input.businessDate || input.businessDate > date) throw new Error("Select today's date or a past business date");
    if (source(config, input.sourceId).kind !== "cash") throw new Error("Shift closing requires a cash source");
    const transfer = money(input.transferAmount ?? 0);
    if (transfer > 0) {
      const destination = source(config, input.destinationSourceId);
      if (destination.account === source(config, input.sourceId).account) throw new Error("Transfer destination must be a different account");
    }
    if (input.countedCash === undefined || input.openingFloat === undefined) throw new Error("Enter opening float and counted cash");
    if (all.some(r => reserved(r) && r.kind === "shift_close" && r.input.businessDate === input.businessDate && r.input.sourceId === input.sourceId))
      throw new Error("This cash source already has a close request for that date");
    const sameDay = all.filter(r => (r.snapshot as unknown as PosSnapshot).date === input.businessDate && r.kind !== "shift_close"
      && ((r.input as PosInput).tenders ?? []).some(t => t.sourceId === input.sourceId));
    if (sameDay.some(r => ["pending", "approved", "failed"].includes(r.status)))
      throw new Error("Resolve all pending/failed cash transactions for this day before closing");
    const posted = sameDay.filter(r => r.status === "posted");
    const movement = posted.reduce((n, r) => n + (r.kind === "return" ? -1 : 1) *
      tenderTotal((r.input as PosInput).tenders?.filter(t => t.sourceId === input.sourceId)), 0);
    return { ...base, date: input.businessDate, paid: 0, cashBasisIds: posted.map(r => r.id).sort((a,b) => a-b),
      ...shiftAmounts(input.openingFloat, movement, input.countedCash, transfer) };
  }
  // A closed cash day cannot accept late sales/payments/refunds.
  for (const t of input.tenders ?? []) if (source(config, t.sourceId).kind === "cash" &&
    all.some(r => reserved(r) && r.kind === "shift_close" && r.input.businessDate === date && r.input.sourceId === t.sourceId))
    throw new Error("This cash source is already closing/closed for today");
  if (input.kind === "sale") {
    if (!input.lines?.length) throw new Error("Select at least one part");
    if (new Set(input.lines.map(l => l.partId)).size !== input.lines.length) throw new Error("Combine repeated parts into one quantity");
    for (const entry of [...input.lines].sort((a,b) => a.partId-b.partId)) {
      const { part, location } = await ensureInventory(tx, dealerId, entry.partId);
      if (!part.active || part.costingMethod !== "average") throw new Error(`${part.sku}: F2 requires active moving-average stock`);
      const [level] = await tx.select().from(inventoryLevelsTable).where(and(
        eq(inventoryLevelsTable.dealerId, dealerId), eq(inventoryLevelsTable.partId, part.id),
        eq(inventoryLevelsTable.locationId, location.id), sql`${inventoryLevelsTable.binId} is null`,
      )).for("update");
      if (!level || level.quantityOnHand - level.quantityReserved - level.quantityNonSellable < entry.quantity)
        throw new Error(`${part.sku}: insufficient unreserved stock in Main warehouse (unbinned)`);
      const brand = config.brands.find(b => b.brand.toLowerCase() === (part.category === "accessories" ? "accessories" : part.make?.trim().toLowerCase()));
      const item = config.items.find(i => i.partId === part.id);
      if (!brand || !item) throw new Error(`${part.sku}: configure its brand accounts and ERP stock item`);
      const unitPrice = money(part.unitPrice);
      if (unitPrice <= 0) throw new Error(`${part.sku}: configure a positive selling price`);
      const net = money(unitPrice * entry.quantity);
      base.lines.push({ ...entry, sku: part.sku, name: part.name, unitPrice, unitCost: level.averageUnitCost,
        net, tax: money(net * config.taxRate / 100), itemCode: item.itemCode, ...brand });
    }
    Object.assign(base, totals(base.lines, paid));
    if (base.balance > 0 && !input.customerId) throw new Error("Select a registered customer for a credit/account sale");
    if (input.customerId) {
      const [customer] = await tx.select({ name: customersTable.name }).from(customersTable).where(and(
        eq(customersTable.dealerId, dealerId), eq(customersTable.id, input.customerId)));
      if (!customer) throw new Error("Customer not found in this dealership");
      base.customerName = customer.name;
    }
    return base;
  }
  const original = all.find(r => r.id === input.originalId && r.kind === "sale" && r.status === "posted");
  if (!original) throw new Error("Select a posted sale in this dealership");
  const old = original.snapshot as unknown as PosSnapshot;
  if (old.erpSite !== conn.siteUrl || old.erpCompany !== conn.companyName)
    throw new Error("The original sale belongs to a different ERP connection; Finance reconciliation is required");
  const related = all.filter(r => r.input.originalId === original.id && reserved(r));
  if (related.some(r => r.status !== "posted" && (input.kind === "return" || r.kind === "return")))
    throw new Error("Finish or reject existing payment/return requests for this sale before submitting a return or further payment");
  base.originalId = original.id;
  base.customerName = old.customerName;
  base.erpCustomer = old.erpCustomer;
  // Reserve pending/approved/failed amounts too. Reject first before replacing.
  const payments = related.filter(r => r.kind === "payment").reduce((n,r) => n + (r.snapshot as unknown as PosSnapshot).paid, old.paid);
  const returns = related.filter(r => r.kind === "return");
  const credits = returns.reduce((n,r) => n + (r.snapshot as unknown as PosSnapshot).total, 0);
  const refunds = returns.reduce((n,r) => n + (r.snapshot as unknown as PosSnapshot).paid, 0);
  const outstanding = money(old.total - credits - payments + refunds);
  if (input.kind === "payment") {
    if (paid <= 0 || paid > outstanding) throw new Error(`Payment must be positive and cannot exceed unallocated balance GYD ${outstanding.toFixed(2)}`);
    return { ...base, total: paid, balance: money(outstanding - paid) };
  }
  if (!input.lines?.length) throw new Error("Select returned parts and quantities");
  if (!input.goodsReceived) throw new Error("Confirm returned goods have physically arrived and are sellable");
  if (new Set(input.lines.map(l => l.partId)).size !== input.lines.length) throw new Error("Combine repeated return lines");
  base.config = old.config; // Reverse the original tax and brand GLs, never today's rates.
  // Refund source must retain the original source mapping; edits require a new configured sale.
  for (const t of input.tenders ?? []) source(old.config, t.sourceId);
  for (const entry of input.lines) {
    const sold = old.lines.find(l => l.partId === entry.partId);
    const already = returns.reduce((n,r) => n + ((r.snapshot as unknown as PosSnapshot).lines.find(l => l.partId === entry.partId)?.quantity ?? 0), 0);
    if (!sold || entry.quantity > sold.quantity - already) throw new Error("Return exceeds remaining sold quantity");
    const net = money(sold.net * entry.quantity / sold.quantity);
    // Allocate final return pennies to the final remaining units.
    const priorNet = returns.reduce((n,r) => n + ((r.snapshot as unknown as PosSnapshot).lines.find(l => l.partId === entry.partId)?.net ?? 0),0);
    const priorTax = returns.reduce((n,r) => n + ((r.snapshot as unknown as PosSnapshot).lines.find(l => l.partId === entry.partId)?.tax ?? 0),0);
    base.lines.push({ ...sold, quantity: entry.quantity,
      net: entry.quantity === sold.quantity - already ? money(sold.net - priorNet) : net,
      tax: entry.quantity === sold.quantity - already ? money(sold.tax - priorTax) : money(sold.tax * entry.quantity / sold.quantity) });
  }
  Object.assign(base, totals(base.lines, paid));
  const requiredRefund = Math.max(0, money(base.total - outstanding));
  if (paid !== requiredRefund) throw new Error(`Refund must be GYD ${requiredRefund.toFixed(2)}; unpaid charges are credited first`);
  if (paid > money(payments - refunds)) throw new Error("Refund exceeds recorded receipts");
  return base;
}

export async function queuePos(tx: PosTx, dealerId: number, id: number, validation = false, revision = 0) {
  await tx.insert(erpnextSyncJobsTable).values({
    dealerId, direction: "outbound", doctype: validation ? "AURA Parts POS Validation" : "AURA Parts POS",
    entityType: validation ? "parts_pos_settings" : "parts_pos", entityId: validation ? dealerId : id,
    operation: "insert", payload: { revision }, status: "queued",
    dedupeKey: validation ? `pos-validation:${dealerId}:${revision}` : `pos:${dealerId}:${id}`,
  }).onConflictDoUpdate({ target: erpnextSyncJobsTable.dedupeKey, set: {
    status: "queued", attempts: 0, lastError: null, nextAttemptAt: new Date(), updatedAt: new Date(),
  } });
}

export async function seedPosParts(tx: PosTx, dealerId: number) {
  if (!await isPosDummy(dealerId)) throw new Error("Test parts can only be created in CAM Motors Dummy");
  const rows = [];
  for (const [index, brand] of ["BYD", "Foton", "Jetour", "BMW", "Accessories"].entries()) {
    const sku = `AURA-POS-TEST-${brand.toUpperCase()}`;
    const [created] = await tx.insert(partsTable).values({
      dealerId, sku, name: `[DUMMY TEST ONLY] ${brand} sample part`,
      make: brand === "Accessories" ? null : brand, category: brand === "Accessories" ? "accessories" : "general",
      description: "Artificial F2 POS fixture. Not a real stocked/sellable product. Do not sync into a live ERP company.",
      unitCost: 1000 + index * 500, unitPrice: 2000 + index * 1000,
      stock: 20, costingMethod: "average", reorderLevel: 2, reorderMax: 30,
    }).onConflictDoNothing().returning();
    const part = created ?? (await tx.select().from(partsTable).where(and(eq(partsTable.dealerId, dealerId), eq(partsTable.sku, sku))))[0];
    await ensureInventory(tx, dealerId, part.id);
    rows.push({ id: part.id, sku: part.sku, stock: part.stock, created: !!created });
  }
  return rows;
}
