import { and, eq, getTableColumns } from "drizzle-orm";
import { db, inventoryCycleCountsTable, inventoryCycleCountLinesTable, partsTable } from "@workspace/db";
import { csv } from "./parts-operations-math";

// Join on both identities: an unrelated dealership's catalog must never name a count line.
export function scopedCountLineQuery(dealerId: number, countId: number) {
  return db.select({
    ...getTableColumns(inventoryCycleCountLinesTable),
    partNumber: partsTable.sku,
    partName: partsTable.name,
  }).from(inventoryCycleCountLinesTable).innerJoin(partsTable, and(
    eq(partsTable.id, inventoryCycleCountLinesTable.partId),
    eq(partsTable.dealerId, inventoryCycleCountLinesTable.dealerId),
  )).where(and(
    eq(inventoryCycleCountLinesTable.dealerId, dealerId),
    eq(inventoryCycleCountLinesTable.cycleCountId, countId),
  )).orderBy(inventoryCycleCountLinesTable.id);
}

export async function countWithPartNames(dealerId: number, countId: number) {
  const [count] = await db.select().from(inventoryCycleCountsTable).where(and(
    eq(inventoryCycleCountsTable.id, countId), eq(inventoryCycleCountsTable.dealerId, dealerId),
  )).limit(1);
  if (!count) return null;
  const lines = await scopedCountLineQuery(dealerId, countId);
  return { ...count, lines };
}

export function countExportRows(lines: { partNumber: string; partName: string; binId: number | null; expectedQty: number; countedQty: number | null; variance: number | null }[]) {
  return lines.map(line => ({
    "Part Number": line.partNumber, "Part Name": line.partName,
    "Bin": line.binId ?? "", "Expected": line.expectedQty,
    "Counted": line.countedQty ?? "", "Variance": line.variance ?? "",
  }));
}

export function reportCsv(rows: Record<string, unknown>[], columns: string[] = ["Part Number", "Part Name"]) {
  // The shared CSV encoder quotes fields, doubles quotes and neutralizes formulas.
  return rows.length ? csv(rows) : csv([Object.fromEntries(columns.map(column => [column, ""]))]).split("\r\n")[0];
}

export function agingExportRows(rows: { sku: string; name: string; category: string | null; locationId: number; quantity: number; currentValue: number; ageDays: number | null; bucket: string }[]) {
  return rows.map(row => ({
    "Part Number": row.sku, "Part Name": row.name, "Category": row.category ?? "",
    "Location": row.locationId, "Idle Qty": row.quantity, "Tied Capital (GYD)": row.currentValue,
    "Age (days)": row.ageDays ?? "", "Age Bucket": row.bucket,
  }));
}