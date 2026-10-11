import { Router, type IRouter } from "express";
import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  shipmentImportBatchesTable,
  shipmentImportRowErrorsTable,
  shipmentLinesTable,
  shipmentManifestsTable,
  shipmentSpecsTable,
  vehiclesTable,
  shipmentMatchProposalsTable,
  shipmentAllocationsTable,
  leadsTable,
  type ShipmentImportBatch,
} from "@workspace/db";
import { PreviewShipmentImportBody, CommitShipmentImportBody } from "@workspace/api-zod";
import { type ImportContext, type ImportRowInput, validateImportRows } from "../../lib/shipments/rules";
import { type DbLike, HttpError, ctx, h, idParam, loadShipment, recordEvent, requireLease, specOut, specsById, isUniqueViolation } from "./common";

const router: IRouter = Router();

async function buildContext(tx: DbLike, dealerId: number, shipmentId: number, kind: "lines" | "manifest"): Promise<ImportContext> {
  const specs = await tx.select().from(shipmentSpecsTable).where(eq(shipmentSpecsTable.dealerId, dealerId));
  const approved = new Map<string, number>();
  const other = new Map<string, string>();
  for (const s of specs) {
    if (s.status === "approved") approved.set(s.specKey, s.id);
    else other.set(s.specKey, s.status);
  }
  const lines = await tx
    .select()
    .from(shipmentLinesTable)
    .where(and(eq(shipmentLinesTable.dealerId, dealerId), eq(shipmentLinesTable.shipmentId, shipmentId)));
  const manifestCounts = await tx
    .select({ specId: shipmentManifestsTable.specId, n: sql<number>`count(*)::int` })
    .from(shipmentManifestsTable)
    .where(and(eq(shipmentManifestsTable.dealerId, dealerId), eq(shipmentManifestsTable.shipmentId, shipmentId)))
    .groupBy(shipmentManifestsTable.specId);
  const vins = await tx
    .select({ vin: shipmentManifestsTable.vin })
    .from(shipmentManifestsTable)
    .where(eq(shipmentManifestsTable.dealerId, dealerId));
  return {
    kind,
    approvedSpecs: approved,
    otherSpecs: other,
    existingLineSpecIds: new Set(lines.map((l) => l.specId)),
    lineQuantity: new Map(lines.map((l) => [l.specId, l.quantity])),
    manifestCount: new Map(manifestCounts.map((m) => [m.specId, m.n])),
    existingVins: new Set(vins.map((v) => v.vin)),
  };
}

function batchOut(b: ShipmentImportBatch, replayed = false) {
  return {
    id: b.id,
    kind: b.kind as "lines" | "manifest",
    fileName: b.fileName,
    totalRows: b.totalRows,
    acceptedRows: b.acceptedRows,
    rejectedRows: b.rejectedRows,
    createdBy: b.createdBy,
    createdAt: b.createdAt,
    replayed,
  };
}

function editableFor(kind: "lines" | "manifest", status: string) {
  if (status === "closed" || status === "cancelled") throw new HttpError(409, `Shipment is ${status}`);
  if (kind === "lines" && status === "arrived") throw new HttpError(409, "Lines cannot be imported after arrival");
}

router.post("/shipments/:shipmentId/imports/preview", h(async (req, res) => {
  const { dealerId } = ctx(res);
  const id = idParam(req, "shipmentId");
  const b = PreviewShipmentImportBody.parse(req.body);
  await loadShipment(db, dealerId, id);
  const results = validateImportRows(b.rows as ImportRowInput[], await buildContext(db, dealerId, id, b.kind));
  const valid = results.filter((r) => r.ok).length;
  res.json({
    validRows: valid,
    invalidRows: results.length - valid,
    rows: results.map((r) => ({ rowNumber: r.rowNumber, ok: r.ok, message: r.message })),
  });
}));

router.get("/shipments/:shipmentId/imports", h(async (req, res) => {
  const { dealerId } = ctx(res);
  const id = idParam(req, "shipmentId");
  await loadShipment(db, dealerId, id);
  const rows = await db
    .select()
    .from(shipmentImportBatchesTable)
    .where(and(eq(shipmentImportBatchesTable.dealerId, dealerId), eq(shipmentImportBatchesTable.shipmentId, id)))
    .orderBy(desc(shipmentImportBatchesTable.createdAt));
  res.json(rows.map((r) => batchOut(r)));
}));

router.post("/shipments/:shipmentId/imports", h(async (req, res) => {
  const { dealerId, actor, user } = ctx(res);
  const id = idParam(req, "shipmentId");
  const b = CommitShipmentImportBody.parse(req.body);
  const out = await db.transaction(async (tx) => {
    const ship = await loadShipment(tx, dealerId, id, true);
    await requireLease(tx, dealerId, id, user.id);
    // Idempotent retry: identical file on the same shipment replays.
    const [existing] = await tx
      .select()
      .from(shipmentImportBatchesTable)
      .where(and(
        eq(shipmentImportBatchesTable.dealerId, dealerId),
        eq(shipmentImportBatchesTable.shipmentId, id),
        eq(shipmentImportBatchesTable.kind, b.kind),
        eq(shipmentImportBatchesTable.fileHash, createHash("sha256").update(JSON.stringify(b.rows)).digest("hex")),
      ));
    if (existing) return batchOut(existing, true);
    editableFor(b.kind, ship.status);
    const results = validateImportRows(b.rows as ImportRowInput[], await buildContext(tx, dealerId, id, b.kind));
    const [batch] = await tx
      .insert(shipmentImportBatchesTable)
      .values({
        dealerId,
        shipmentId: id,
        kind: b.kind,
        fileName: b.fileName,
        fileHash: createHash("sha256").update(JSON.stringify(b.rows)).digest("hex"),
        totalRows: results.length,
        acceptedRows: 0,
        rejectedRows: 0,
        createdBy: actor,
      })
      .returning();
    const rawByRow = new Map(b.rows.map((r) => [r.rowNumber, r]));
    const errors: { rowNumber: number; message: string }[] = [];
    let accepted = 0;
    for (const r of results) {
      if (!r.ok) {
        errors.push({ rowNumber: r.rowNumber, message: r.message });
        continue;
      }
      try {
        await tx.transaction(async (sp) => {
          if (b.kind === "lines")
            await sp.insert(shipmentLinesTable).values({ dealerId, shipmentId: id, specId: r.specId, quantity: r.quantity!, importBatchId: batch!.id, createdBy: actor });
          else
            await sp.insert(shipmentManifestsTable).values({ dealerId, shipmentId: id, specId: r.specId, vin: r.vin!, importBatchId: batch!.id, createdBy: actor });
        });
        accepted += 1;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        errors.push({ rowNumber: r.rowNumber, message: "Rejected by a uniqueness rule (duplicate line or VIN)" });
      }
    }
    if (errors.length)
      await tx.insert(shipmentImportRowErrorsTable).values(errors.map((e) => ({
        dealerId,
        batchId: batch!.id,
        rowNumber: e.rowNumber,
        message: e.message,
        rawRow: JSON.stringify(rawByRow.get(e.rowNumber) ?? {}),
      })));
    const [done] = await tx
      .update(shipmentImportBatchesTable)
      .set({ acceptedRows: accepted, rejectedRows: errors.length })
      .where(eq(shipmentImportBatchesTable.id, batch!.id))
      .returning();
    await recordEvent(tx, {
      dealerId,
      shipmentId: id,
      kind: `import_${b.kind}`,
      detail: `${b.fileName}: ${accepted} accepted, ${errors.length} rejected`,
      actor,
    });
    return batchOut(done!);
  });
  res.status(out.replayed ? 200 : 201).json(out);
}));

router.get("/shipments/imports/:batchId/errors", h(async (req, res) => {
  const { dealerId } = ctx(res);
  const batchId = idParam(req, "batchId");
  const [batch] = await db
    .select({ id: shipmentImportBatchesTable.id })
    .from(shipmentImportBatchesTable)
    .where(and(eq(shipmentImportBatchesTable.id, batchId), eq(shipmentImportBatchesTable.dealerId, dealerId)));
  if (!batch) throw new HttpError(404, "Import batch not found");
  const rows = await db
    .select()
    .from(shipmentImportRowErrorsTable)
    .where(and(eq(shipmentImportRowErrorsTable.batchId, batchId), eq(shipmentImportRowErrorsTable.dealerId, dealerId)))
    .orderBy(shipmentImportRowErrorsTable.rowNumber);
  res.json(rows.map((r) => ({ rowNumber: r.rowNumber, message: r.message, rawRow: r.rawRow })));
}));

router.get("/shipments/:shipmentId/manifests", h(async (req, res) => {
  const { dealerId } = ctx(res);
  const id = idParam(req, "shipmentId");
  await loadShipment(db, dealerId, id);
  const rows = await db
    .select({
      m: shipmentManifestsTable,
      vehicleId: vehiclesTable.id,
      vehicleStatus: vehiclesTable.status,
      proposalId: shipmentMatchProposalsTable.id,
      proposalStatus: shipmentMatchProposalsTable.status,
      allocationId: shipmentMatchProposalsTable.allocationId,
      leadName: leadsTable.name,
    })
    .from(shipmentManifestsTable)
    .leftJoin(vehiclesTable, and(
      eq(vehiclesTable.dealerId, shipmentManifestsTable.dealerId),
      eq(vehiclesTable.vin, shipmentManifestsTable.vin),
      sql`${vehiclesTable.deletedAt} is null`,
    ))
    .leftJoin(shipmentMatchProposalsTable, and(
      eq(shipmentMatchProposalsTable.manifestId, shipmentManifestsTable.id),
      sql`${shipmentMatchProposalsTable.status} in ('pending','confirmed')`,
    ))
    .leftJoin(shipmentAllocationsTable, eq(shipmentAllocationsTable.id, shipmentMatchProposalsTable.allocationId))
    .leftJoin(leadsTable, eq(leadsTable.id, shipmentAllocationsTable.leadId))
    .where(and(eq(shipmentManifestsTable.dealerId, dealerId), eq(shipmentManifestsTable.shipmentId, id)))
    .orderBy(shipmentManifestsTable.specId, shipmentManifestsTable.vin);
  const specs = await specsById(db, dealerId, rows.map((r) => r.m.specId));
  res.json(rows.map((r) => ({
    id: r.m.id,
    vin: r.m.vin,
    specId: r.m.specId,
    spec: specOut(specs.get(r.m.specId)!, true),
    status: r.m.status as "unmatched" | "proposed" | "confirmed",
    inventoryVehicleId: r.vehicleId ?? null,
    inventoryStatus: r.vehicleStatus ?? null,
    proposalId: r.proposalId ?? null,
    proposalStatus: r.proposalStatus ?? null,
    allocationId: r.allocationId ?? null,
    leadName: r.leadName ?? null,
    createdAt: r.m.createdAt,
  })));
}));

export default router;
