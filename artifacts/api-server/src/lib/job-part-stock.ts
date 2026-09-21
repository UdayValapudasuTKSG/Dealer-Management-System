import { and, asc, eq, inArray } from "drizzle-orm";
import { db, jobCardPartsTable, partsTable, inventoryHoldsTable } from "@workspace/db";
import { createHold, moveStock, releaseHold, consumeHold } from "./parts-inventory";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Line = typeof jobCardPartsTable.$inferSelect;

/** Null denotes a historical line: never deduct its already-issued stock again. */
export function issuedUnits(line: Line): number {
  return line.issuedQuantity ?? (line.kind === "issue" && !line.backordered ? line.quantity : 0);
}

export async function reserveJobPart(tx: Tx, line: Line) {
  const hold = await createHold(tx, {
    dealerId: line.dealerId, partId: line.partId, quantity: line.quantity,
    locationId: line.inventoryLocationId ?? undefined, binId: line.inventoryBinId,
    referenceType: "job_card_part", referenceId: String(line.id),
  });
  await tx.update(jobCardPartsTable).set({
    inventoryHoldId: hold.id, inventoryLocationId: hold.locationId,
    inventoryBinId: hold.binId, issuedQuantity: 0, backordered: hold.backorderRisk,
  }).where(and(eq(jobCardPartsTable.id, line.id), eq(jobCardPartsTable.dealerId, line.dealerId)));
  return hold;
}

/** Caller holds the job-card lock. Releasing our reservation and issuing are atomic. */
export async function issueJobParts(tx: Tx, dealerId: number, jobCardId: number, lineId?: number) {
  const lines = await tx.select().from(jobCardPartsTable).where(and(
    eq(jobCardPartsTable.dealerId, dealerId), eq(jobCardPartsTable.jobCardId, jobCardId),
    eq(jobCardPartsTable.kind, "issue"),
    lineId === undefined ? undefined : eq(jobCardPartsTable.id, lineId),
  )).orderBy(asc(jobCardPartsTable.partId), asc(jobCardPartsTable.id)).for("update");
  if (lineId !== undefined && !lines.length) throw Object.assign(new Error("Part line not found"), { status: 404 });
  // Pre-lock all parts in stable order before touching holds or inventory levels.
  for (const partId of [...new Set(lines.map(line => line.partId))]) {
    await tx.select({ id: partsTable.id }).from(partsTable).where(and(
      eq(partsTable.id, partId), eq(partsTable.dealerId, dealerId),
    )).for("update");
  }
  const issued: { id: number; partId: number; quantity: number; part: typeof partsTable.$inferSelect }[] = [];
  for (const line of lines) {
    const quantity = line.quantity - issuedUnits(line);
    if (quantity <= 0) continue;
    const [part] = await tx.select().from(partsTable).where(and(
      eq(partsTable.id, line.partId), eq(partsTable.dealerId, dealerId),
    ));
    if (!part) throw new Error("Part not found in dealership");
    const issue = {
      dealerId, partId: line.partId, locationId: line.inventoryLocationId ?? undefined,
      binId: line.inventoryBinId, type: "issue" as const, quantityDelta: -quantity,
      referenceType: "job_card_part", referenceId: String(line.id),
      idempotencyKey: `job-part-issue:${dealerId}:${line.id}:${line.quantity}`,
    };
    const movement = line.inventoryHoldId
      ? await consumeHold(tx, dealerId, line.inventoryHoldId, issue)
      : await moveStock(tx, issue);
    await tx.update(jobCardPartsTable).set({
      issuedQuantity: line.quantity, issuedAt: new Date(), backordered: false,
      unitCost: movement.unitCostAtTransaction,
    }).where(and(eq(jobCardPartsTable.id, line.id), eq(jobCardPartsTable.dealerId, dealerId)));
    issued.push({ id: line.id, partId: line.partId, quantity, part });
  }
  return issued;
}

export async function releaseJobPartHolds(tx: Tx, dealerId: number, jobCardId: number) {
  const lines = await tx.select().from(jobCardPartsTable).where(and(
    eq(jobCardPartsTable.dealerId, dealerId), eq(jobCardPartsTable.jobCardId, jobCardId),
  )).orderBy(asc(jobCardPartsTable.partId));
  const manualHolds = await tx.select().from(inventoryHoldsTable).where(and(
    eq(inventoryHoldsTable.dealerId, dealerId), eq(inventoryHoldsTable.referenceId, String(jobCardId)),
    inArray(inventoryHoldsTable.referenceType, ["job", "estimate"]), eq(inventoryHoldsTable.status, "active"),
  ));
  const release = new Map(manualHolds.map(hold => [hold.id, { id: hold.id, partId: hold.partId }]));
  for (const line of lines) {
    if (line.inventoryHoldId && issuedUnits(line) < line.quantity) {
      release.set(line.inventoryHoldId, { id: line.inventoryHoldId, partId: line.partId });
    }
  }
  for (const hold of [...release.values()].sort((a, b) => a.partId - b.partId || a.id - b.id)) {
    await releaseHold(tx, dealerId, hold.id);
    await tx.update(jobCardPartsTable).set({ inventoryHoldId: null }).where(and(
      eq(jobCardPartsTable.dealerId, dealerId), eq(jobCardPartsTable.jobCardId, jobCardId),
      eq(jobCardPartsTable.inventoryHoldId, hold.id),
    ));
  }
}