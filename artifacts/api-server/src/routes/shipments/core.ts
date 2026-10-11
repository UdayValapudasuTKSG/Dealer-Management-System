import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  shipmentSpecsTable,
  shipmentsTable,
  shipmentLinesTable,
  shipmentAllocationsTable,
  shipmentEditLocksTable,
  shipmentEventsTable,
  shipmentManifestsTable,
} from "@workspace/db";
import {
  CreateShipmentSpecBody,
  UpdateShipmentSpecBody,
  SetShipmentSpecStatusBody,
  CreateShipmentBody,
  UpdateShipmentBody,
  SetShipmentStatusBody,
  AddShipmentLineBody,
  UpdateShipmentLineBody,
} from "@workspace/api-zod";
import {
  LEASE_TTL_MS,
  SHIPMENT_TRANSITIONS,
  evaluateLease,
  normaliseSpecText,
  specKey,
  specLabel,
} from "../../lib/shipments/rules";
import {
  HttpError,
  ctx,
  h,
  idParam,
  loadShipment,
  recordEvent,
  requireLease,
  requirePerm,
  specOut,
} from "./common";
import { lockState, shipmentDetail, shipmentSummaries } from "./views";
import { queueEtaChangeEmail } from "./outbox";

const router: IRouter = Router();
const LIVE = ["active", "fulfilled"];

function normSpec(b: { make: string; model: string; year: number; variant: string; exteriorColor: string; interiorColor: string }) {
  const out = {
    make: normaliseSpecText(b.make),
    model: normaliseSpecText(b.model),
    year: b.year,
    variant: normaliseSpecText(b.variant),
    exteriorColor: normaliseSpecText(b.exteriorColor),
    interiorColor: normaliseSpecText(b.interiorColor),
  };
  for (const [k, v] of Object.entries(out))
    if (typeof v === "string" && !v) throw new HttpError(400, `${k} is blank - enter a value or explicit N/A`);
  return out;
}

// ------------------------------------------------------------ catalogue

router.get("/shipments/specs", h(async (_req, res) => {
  const { dealerId } = ctx(res);
  const specs = await db
    .select()
    .from(shipmentSpecsTable)
    .where(eq(shipmentSpecsTable.dealerId, dealerId))
    .orderBy(shipmentSpecsTable.make, shipmentSpecsTable.model, desc(shipmentSpecsTable.year), shipmentSpecsTable.id);
  const used = await db
    .selectDistinct({ specId: shipmentLinesTable.specId })
    .from(shipmentLinesTable)
    .where(eq(shipmentLinesTable.dealerId, dealerId));
  const u = new Set(used.map((x) => x.specId));
  res.json(specs.map((s) => specOut(s, u.has(s.id))));
}));

router.post("/shipments/specs", h(async (req, res) => {
  const { dealerId, actor } = ctx(res);
  const spec = normSpec(CreateShipmentSpecBody.parse(req.body));
  const [row] = await db
    .insert(shipmentSpecsTable)
    .values({ dealerId, ...spec, specKey: specKey(spec), status: "draft", createdBy: actor })
    .returning();
  await recordEvent(db, { dealerId, shipmentId: null, kind: "spec_created", detail: `Draft spec ${specLabel(spec)}`, actor });
  res.status(201).json(specOut(row!));
}));

router.put("/shipments/specs/:specId", h(async (req, res) => {
  const { dealerId, actor } = ctx(res);
  const id = idParam(req, "specId");
  const spec = normSpec(UpdateShipmentSpecBody.parse(req.body));
  const row = await db.transaction(async (tx) => {
    const [cur] = await tx
      .select()
      .from(shipmentSpecsTable)
      .where(and(eq(shipmentSpecsTable.id, id), eq(shipmentSpecsTable.dealerId, dealerId)))
      .for("update");
    if (!cur) throw new HttpError(404, "Spec not found");
    if (cur.status !== "draft")
      throw new HttpError(409, "Only draft specs can be edited - approved specs are immutable (retire and create a new one)");
    const [upd] = await tx
      .update(shipmentSpecsTable)
      .set({ ...spec, specKey: specKey(spec) })
      .where(eq(shipmentSpecsTable.id, id))
      .returning();
    await recordEvent(tx, { dealerId, shipmentId: null, kind: "spec_edited", detail: `Draft spec #${id} -> ${specLabel(spec)}`, actor });
    return upd!;
  });
  res.json(specOut(row));
}));

router.post("/shipments/specs/:specId/status", h(async (req, res) => {
  const { dealerId, actor, user } = ctx(res);
  requirePerm(user, [["deals", "approve"], ["inventory", "approve"]], "approve or retire catalogue specifications");
  const id = idParam(req, "specId");
  const { status } = SetShipmentSpecStatusBody.parse(req.body);
  const row = await db.transaction(async (tx) => {
    const [cur] = await tx
      .select()
      .from(shipmentSpecsTable)
      .where(and(eq(shipmentSpecsTable.id, id), eq(shipmentSpecsTable.dealerId, dealerId)))
      .for("update");
    if (!cur) throw new HttpError(404, "Spec not found");
    const ok =
      (cur.status === "draft" && (status === "approved" || status === "retired")) ||
      (cur.status === "approved" && status === "retired") ||
      (cur.status === "retired" && status === "approved");
    if (!ok) throw new HttpError(409, `Cannot move a ${cur.status} spec to ${status}`);
    if (status === "retired") {
      const [active] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(shipmentAllocationsTable)
        .where(and(eq(shipmentAllocationsTable.dealerId, dealerId), eq(shipmentAllocationsTable.specId, id), eq(shipmentAllocationsTable.status, "active")));
      if ((active?.n ?? 0) > 0) throw new HttpError(409, "Spec has active allocations - release or fulfil them before retiring");
    }
    const [upd] = await tx
      .update(shipmentSpecsTable)
      .set(status === "approved" ? { status, approvedBy: actor, approvedAt: new Date() } : { status })
      .where(eq(shipmentSpecsTable.id, id))
      .returning();
    await recordEvent(tx, { dealerId, shipmentId: null, kind: `spec_${status}`, detail: `${specLabel(cur)} ${status}`, actor });
    return upd!;
  });
  res.json(specOut(row));
}));

// ------------------------------------------------------------ shipments

router.get("/shipments", h(async (_req, res) => {
  const { dealerId } = ctx(res);
  const ships = await db
    .select()
    .from(shipmentsTable)
    .where(eq(shipmentsTable.dealerId, dealerId))
    .orderBy(shipmentsTable.currentEtaMonth, shipmentsTable.id);
  res.json(await shipmentSummaries(db, dealerId, ships));
}));

router.post("/shipments", h(async (req, res) => {
  const { dealerId, actor } = ctx(res);
  const b = CreateShipmentBody.parse(req.body);
  const reference = b.reference.trim();
  if (!reference) throw new HttpError(400, "Reference is required");
  const row = await db.transaction(async (tx) => {
    const [s] = await tx
      .insert(shipmentsTable)
      .values({ dealerId, reference, baselineEtaMonth: b.etaMonth, currentEtaMonth: b.etaMonth, notes: b.notes ?? null, createdBy: actor })
      .returning();
    await recordEvent(tx, { dealerId, shipmentId: s!.id, kind: "shipment_created", detail: `Shipment ${reference} created, ETA ${b.etaMonth}`, actor });
    return s!;
  });
  const [summary] = await shipmentSummaries(db, dealerId, [row]);
  res.status(201).json(summary);
}));

router.get("/shipments/:shipmentId", h(async (req, res) => {
  const { dealerId, user } = ctx(res);
  res.json(await shipmentDetail(db, dealerId, idParam(req, "shipmentId"), user.id));
}));

router.put("/shipments/:shipmentId", h(async (req, res) => {
  const { dealerId, actor, user } = ctx(res);
  const id = idParam(req, "shipmentId");
  const b = UpdateShipmentBody.parse(req.body);
  await db.transaction(async (tx) => {
    const ship = await loadShipment(tx, dealerId, id, true);
    await requireLease(tx, dealerId, id, user.id);
    if (ship.status === "closed" || ship.status === "cancelled") throw new HttpError(409, `Shipment is ${ship.status}`);
    const patch: Partial<typeof shipmentsTable.$inferInsert> = {};
    if (b.reference !== undefined) patch.reference = b.reference.trim();
    if (b.notes !== undefined) patch.notes = b.notes;
    const etaChanged = b.currentEtaMonth !== undefined && b.currentEtaMonth !== ship.currentEtaMonth;
    if (etaChanged) patch.currentEtaMonth = b.currentEtaMonth!;
    if (Object.keys(patch).length) await tx.update(shipmentsTable).set(patch).where(eq(shipmentsTable.id, id));
    if (etaChanged) {
      const allocs = await tx
        .select()
        .from(shipmentAllocationsTable)
        .where(and(eq(shipmentAllocationsTable.dealerId, dealerId), eq(shipmentAllocationsTable.shipmentId, id), eq(shipmentAllocationsTable.status, "active")));
      let withheld = 0;
      let suppressed = 0;
      for (const a of allocs) {
        const st = await queueEtaChangeEmail(tx, { dealerId, shipmentId: id, allocationId: a.id, etaMonth: b.currentEtaMonth! });
        if (st === "suppressed") suppressed += 1;
        else withheld += 1;
      }
      await recordEvent(tx, {
        dealerId,
        shipmentId: id,
        kind: "eta_changed",
        detail: `ETA ${ship.currentEtaMonth} -> ${b.currentEtaMonth}. ${allocs.length} customer(s): ${withheld} email(s) queued as withheld, ${suppressed} logged only (outside window).`,
        actor,
      });
    } else if (Object.keys(patch).length) {
      await recordEvent(tx, { dealerId, shipmentId: id, kind: "shipment_updated", detail: "Header updated", actor });
    }
  });
  res.json(await shipmentDetail(db, dealerId, id, user.id));
}));

router.post("/shipments/:shipmentId/status", h(async (req, res) => {
  const { dealerId, actor, user } = ctx(res);
  const id = idParam(req, "shipmentId");
  const { status } = SetShipmentStatusBody.parse(req.body);
  await db.transaction(async (tx) => {
    const ship = await loadShipment(tx, dealerId, id, true);
    await requireLease(tx, dealerId, id, user.id);
    if (!(SHIPMENT_TRANSITIONS[ship.status] ?? []).includes(status))
      throw new HttpError(409, `Cannot move a ${ship.status} shipment to ${status}`);
    if (status === "closed" || status === "cancelled") {
      const [a] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(shipmentAllocationsTable)
        .where(and(eq(shipmentAllocationsTable.dealerId, dealerId), eq(shipmentAllocationsTable.shipmentId, id), eq(shipmentAllocationsTable.status, "active")));
      if ((a?.n ?? 0) > 0)
        throw new HttpError(409, `${a!.n} active allocation(s) remain - release, reassign or fulfil them before ${status === "closed" ? "closing" : "cancelling"}`);
    }
    await tx.update(shipmentsTable).set({ status }).where(eq(shipmentsTable.id, id));
    await recordEvent(tx, { dealerId, shipmentId: id, kind: "status_changed", detail: `${ship.status} -> ${status}`, actor });
  });
  res.json(await shipmentDetail(db, dealerId, id, user.id));
}));

// ------------------------------------------------------------ lines

router.post("/shipments/:shipmentId/lines", h(async (req, res) => {
  const { dealerId, actor, user } = ctx(res);
  const id = idParam(req, "shipmentId");
  const b = AddShipmentLineBody.parse(req.body);
  await db.transaction(async (tx) => {
    const ship = await loadShipment(tx, dealerId, id, true);
    await requireLease(tx, dealerId, id, user.id);
    if (ship.status !== "open" && ship.status !== "in_transit")
      throw new HttpError(409, `Lines can only be added while the shipment is open or in transit (it is ${ship.status})`);
    const [spec] = await tx
      .select()
      .from(shipmentSpecsTable)
      .where(and(eq(shipmentSpecsTable.id, b.specId), eq(shipmentSpecsTable.dealerId, dealerId)));
    if (!spec || spec.status !== "approved") throw new HttpError(400, "Only manager-approved catalogue specs can be added");
    await tx.insert(shipmentLinesTable).values({ dealerId, shipmentId: id, specId: spec.id, quantity: b.quantity, createdBy: actor });
    await recordEvent(tx, { dealerId, shipmentId: id, kind: "line_added", detail: `${b.quantity} x ${specLabel(spec)}`, actor });
  });
  res.status(201).json(await shipmentDetail(db, dealerId, id, user.id));
}));

router.put("/shipments/:shipmentId/lines/:lineId", h(async (req, res) => {
  const { dealerId, actor, user } = ctx(res);
  const id = idParam(req, "shipmentId");
  const lineId = idParam(req, "lineId");
  const { quantity } = UpdateShipmentLineBody.parse(req.body);
  await db.transaction(async (tx) => {
    const ship = await loadShipment(tx, dealerId, id, true);
    await requireLease(tx, dealerId, id, user.id);
    if (ship.status === "closed" || ship.status === "cancelled") throw new HttpError(409, `Shipment is ${ship.status}`);
    const [line] = await tx
      .select()
      .from(shipmentLinesTable)
      .where(and(eq(shipmentLinesTable.id, lineId), eq(shipmentLinesTable.shipmentId, id), eq(shipmentLinesTable.dealerId, dealerId)))
      .for("update");
    if (!line) throw new HttpError(404, "Line not found");
    const [a] = await tx
      .select({ n: sql<number>`coalesce(sum(${shipmentAllocationsTable.quantity}),0)::int` })
      .from(shipmentAllocationsTable)
      .where(and(eq(shipmentAllocationsTable.shipmentLineId, lineId), inArray(shipmentAllocationsTable.status, LIVE)));
    if (quantity < (a?.n ?? 0))
      throw new HttpError(409, `Cannot reduce below ${a!.n} allocated unit(s)`);
    const [m] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(shipmentManifestsTable)
      .where(and(eq(shipmentManifestsTable.shipmentId, id), eq(shipmentManifestsTable.specId, line.specId)));
    if (quantity < (m?.n ?? 0)) throw new HttpError(409, `Cannot reduce below ${m!.n} manifest VIN(s) already imported`);
    await tx.update(shipmentLinesTable).set({ quantity }).where(eq(shipmentLinesTable.id, lineId));
    await recordEvent(tx, { dealerId, shipmentId: id, kind: "line_quantity", detail: `Line #${lineId}: ${line.quantity} -> ${quantity}`, actor });
  });
  res.json(await shipmentDetail(db, dealerId, id, user.id));
}));

router.delete("/shipments/:shipmentId/lines/:lineId", h(async (req, res) => {
  const { dealerId, actor, user } = ctx(res);
  const id = idParam(req, "shipmentId");
  const lineId = idParam(req, "lineId");
  await db.transaction(async (tx) => {
    const ship = await loadShipment(tx, dealerId, id, true);
    await requireLease(tx, dealerId, id, user.id);
    if (ship.status === "closed" || ship.status === "cancelled") throw new HttpError(409, `Shipment is ${ship.status}`);
    const [line] = await tx
      .select()
      .from(shipmentLinesTable)
      .where(and(eq(shipmentLinesTable.id, lineId), eq(shipmentLinesTable.shipmentId, id), eq(shipmentLinesTable.dealerId, dealerId)))
      .for("update");
    if (!line) throw new HttpError(404, "Line not found");
    const [a] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(shipmentAllocationsTable)
      .where(eq(shipmentAllocationsTable.shipmentLineId, lineId));
    if ((a?.n ?? 0) > 0) throw new HttpError(409, "Line has allocation history - set quantity instead of deleting");
    const [m] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(shipmentManifestsTable)
      .where(and(eq(shipmentManifestsTable.shipmentId, id), eq(shipmentManifestsTable.specId, line.specId)));
    if ((m?.n ?? 0) > 0) throw new HttpError(409, "Line has manifest VINs - cannot delete");
    await tx.delete(shipmentLinesTable).where(eq(shipmentLinesTable.id, lineId));
    await recordEvent(tx, { dealerId, shipmentId: id, kind: "line_removed", detail: `Line #${lineId} removed`, actor });
  });
  res.json(await shipmentDetail(db, dealerId, id, user.id));
}));

// ------------------------------------------------------------ lease

router.get("/shipments/:shipmentId/lock", h(async (req, res) => {
  const { dealerId, user } = ctx(res);
  const id = idParam(req, "shipmentId");
  await loadShipment(db, dealerId, id);
  res.json(await lockState(db, dealerId, id, user.id));
}));

router.post("/shipments/:shipmentId/lock", h(async (req, res) => {
  const { dealerId, user, actor } = ctx(res);
  requirePerm(user, [["inventory", "edit"], ["leads", "edit"]], "edit shipments");
  const id = idParam(req, "shipmentId");
  await db.transaction(async (tx) => {
    await loadShipment(tx, dealerId, id, true);
    const [lock] = await tx
      .select()
      .from(shipmentEditLocksTable)
      .where(and(eq(shipmentEditLocksTable.shipmentId, id), eq(shipmentEditLocksTable.dealerId, dealerId)))
      .for("update");
    const now = new Date();
    const state = evaluateLease(lock, user.id, now);
    if (state === "other") throw new HttpError(423, `${lock!.holderName} is editing this shipment`, "locked");
    const expiresAt = new Date(now.getTime() + LEASE_TTL_MS);
    if (lock) {
      await tx
        .update(shipmentEditLocksTable)
        .set({ holderUserId: user.id, holderName: actor, expiresAt, ...(state === "free" ? { acquiredAt: now } : {}) })
        .where(eq(shipmentEditLocksTable.id, lock.id));
    } else {
      await tx.insert(shipmentEditLocksTable).values({ dealerId, shipmentId: id, holderUserId: user.id, holderName: actor, expiresAt });
    }
    if (state === "free")
      await recordEvent(tx, { dealerId, shipmentId: id, kind: "lease_acquired", detail: `${actor} started editing`, actor });
  });
  res.json(await lockState(db, dealerId, id, user.id));
}));

router.delete("/shipments/:shipmentId/lock", h(async (req, res) => {
  const { dealerId, user } = ctx(res);
  const id = idParam(req, "shipmentId");
  await db
    .delete(shipmentEditLocksTable)
    .where(and(eq(shipmentEditLocksTable.shipmentId, id), eq(shipmentEditLocksTable.dealerId, dealerId), eq(shipmentEditLocksTable.holderUserId, user.id)));
  res.json(await lockState(db, dealerId, id, user.id));
}));

router.get("/shipments/:shipmentId/events", h(async (req, res) => {
  const { dealerId } = ctx(res);
  const id = idParam(req, "shipmentId");
  await loadShipment(db, dealerId, id);
  const rows = await db
    .select()
    .from(shipmentEventsTable)
    .where(and(eq(shipmentEventsTable.dealerId, dealerId), eq(shipmentEventsTable.shipmentId, id)))
    .orderBy(desc(shipmentEventsTable.createdAt), desc(shipmentEventsTable.id))
    .limit(500);
  res.json(rows);
}));

export default router;
