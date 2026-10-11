import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  db,
  dealsTable,
  leadsTable,
  reservationAllocationsTable,
  shipmentAllocationsTable,
  shipmentEmailJobsTable,
  shipmentEditLocksTable,
  shipmentLinesTable,
  shipmentManifestsTable,
  shipmentMatchProposalsTable,
  shipmentSpecsTable,
  shipmentsTable,
} from "@workspace/db";
import {
  CreateShipmentAllocationBody,
  ReleaseShipmentAllocationBody,
  ReassignShipmentAllocationBody,
} from "@workspace/api-zod";
import { allocateCapacity, evaluateLease, shipmentAcceptsAllocations, specLabel } from "../../lib/shipments/rules";
import { HttpError, type Tx, ctx, h, idParam, loadShipment, recordEvent, requireLease, requirePerm } from "./common";
import { allocationViews } from "./views";
import { queueInitialEmail } from "./outbox";

const router: IRouter = Router();
const LIVE = ["active", "fulfilled"];
const ELIGIBLE_LEAD_PHASE = "negotiation"; // displayed as Pre-Book; reached only through the gated Pre-Book review

const ALLOC_PERMS: [string, string][] = [["leads", "edit"]];

/** Lead must be dealer-scoped, live and at approved Pre-Book. */
async function eligibleLead(tx: Tx | typeof db, dealerId: number, leadId: number) {
  const [lead] = await tx
    .select()
    .from(leadsTable)
    .where(and(eq(leadsTable.id, leadId), eq(leadsTable.dealerId, dealerId), isNull(leadsTable.deletedAt)));
  if (!lead) throw new HttpError(404, "Lead not found for this dealership");
  if (lead.phase !== ELIGIBLE_LEAD_PHASE)
    throw new HttpError(409, "Lead is not at an approved Pre-Book stage - complete the Pre-Book review first");
  return lead;
}

async function checkDeal(tx: Tx, dealerId: number, leadId: number, dealId: number | null | undefined) {
  if (dealId == null) return null;
  const [deal] = await tx
    .select()
    .from(dealsTable)
    .where(and(eq(dealsTable.id, dealId), eq(dealsTable.dealerId, dealerId)));
  if (!deal || deal.leadId !== leadId) throw new HttpError(400, "Deal does not belong to this lead");
  if (deal.stage !== "desking" && deal.stage !== "committed")
    throw new HttpError(409, `Deal is ${deal.stage}; only desking or committed deals can be linked`);
  return deal;
}

async function lockedLine(tx: Tx, dealerId: number, lineId: number) {
  const [line] = await tx
    .select()
    .from(shipmentLinesTable)
    .where(and(eq(shipmentLinesTable.id, lineId), eq(shipmentLinesTable.dealerId, dealerId)))
    .for("update");
  if (!line) throw new HttpError(404, "Shipment line not found");
  return line;
}

/** Capacity units still claimable on a line (exact, inside the line lock). */
async function lineCapacity(tx: Tx, line: { id: number; quantity: number; shipmentId: number; specId: number }, status: string) {
  const [a] = await tx
    .select({ n: sql<number>`coalesce(sum(${shipmentAllocationsTable.quantity}),0)::int` })
    .from(shipmentAllocationsTable)
    .where(and(eq(shipmentAllocationsTable.shipmentLineId, line.id), inArray(shipmentAllocationsTable.status, LIVE)));
  const allocated = a?.n ?? 0;
  const accept = shipmentAcceptsAllocations(status);
  if (accept === "no") throw new HttpError(409, `Shipment is ${status} and no longer accepts allocations`);
  if (accept === "yes") return { lineQuantity: line.quantity, allocated };
  // Arrived: only reconciled (manifested) units that remain unclaimed.
  const [m] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(shipmentManifestsTable)
    .where(and(eq(shipmentManifestsTable.shipmentId, line.shipmentId), eq(shipmentManifestsTable.specId, line.specId)));
  return { lineQuantity: Math.min(line.quantity, m?.n ?? 0), allocated };
}

/** Confirmed proposals whose reservation hold is still live (active/finalized). */
async function liveConfirmedHolds(tx: Tx, allocationId: number) {
  const rows = await tx
    .select({ id: shipmentMatchProposalsTable.id, ledger: reservationAllocationsTable.status })
    .from(shipmentMatchProposalsTable)
    .leftJoin(reservationAllocationsTable, eq(reservationAllocationsTable.id, shipmentMatchProposalsTable.reservationAllocationId))
    .where(and(eq(shipmentMatchProposalsTable.allocationId, allocationId), eq(shipmentMatchProposalsTable.status, "confirmed")));
  return rows.filter((r) => r.ledger === "active" || r.ledger === "finalized").length;
}

async function supersedePending(tx: Tx, allocationId: number, reason: string, actor: string) {
  await tx.update(shipmentEmailJobsTable).set({ status: "superseded", reason })
    .where(and(eq(shipmentEmailJobsTable.allocationId, allocationId),
      inArray(shipmentEmailJobsTable.status, ["queued", "withheld"])));
  const rows = await tx
    .update(shipmentMatchProposalsTable)
    .set({ status: "superseded", lastBlockedReason: reason, decidedBy: actor, decidedAt: new Date() })
    .where(and(eq(shipmentMatchProposalsTable.allocationId, allocationId), eq(shipmentMatchProposalsTable.status, "pending")))
    .returning({ manifestId: shipmentMatchProposalsTable.manifestId });
  if (rows.length)
    await tx
      .update(shipmentManifestsTable)
      .set({ status: "unmatched" })
      .where(and(inArray(shipmentManifestsTable.id, rows.map((r) => r.manifestId)), eq(shipmentManifestsTable.status, "proposed")));
}

router.get("/shipments/tracking", h(async (_req, res) => {
  const { dealerId } = ctx(res);
  const rows = await db
    .select()
    .from(shipmentAllocationsTable)
    .where(eq(shipmentAllocationsTable.dealerId, dealerId))
    .orderBy(desc(shipmentAllocationsTable.createdAt), desc(shipmentAllocationsTable.id))
    .limit(1000);
  res.json(await allocationViews(db, dealerId, rows));
}));

router.get("/shipments/eligible-leads", h(async (_req, res) => {
  const { dealerId } = ctx(res);
  const leads = await db
    .select({ id: leadsTable.id, name: leadsTable.name, email: leadsTable.email, phase: leadsTable.phase })
    .from(leadsTable)
    .where(and(eq(leadsTable.dealerId, dealerId), eq(leadsTable.phase, ELIGIBLE_LEAD_PHASE), isNull(leadsTable.deletedAt)))
    .orderBy(leadsTable.name)
    .limit(500);
  const deals = leads.length
    ? await db
        .select({ id: dealsTable.id, stage: dealsTable.stage, leadId: dealsTable.leadId })
        .from(dealsTable)
        .where(and(
          eq(dealsTable.dealerId, dealerId),
          inArray(dealsTable.leadId, leads.map((l) => l.id)),
          inArray(dealsTable.stage, ["desking", "committed"]),
        ))
    : [];
  res.json(leads.map((l) => ({
    id: l.id,
    name: l.name,
    email: l.email,
    status: "Pre-Book",
    deals: deals.filter((d) => d.leadId === l.id).map((d) => ({ id: d.id, stage: d.stage })),
  })));
}));

router.get("/shipments/:shipmentId/allocations", h(async (req, res) => {
  const { dealerId } = ctx(res);
  const id = idParam(req, "shipmentId");
  await loadShipment(db, dealerId, id);
  const rows = await db
    .select()
    .from(shipmentAllocationsTable)
    .where(and(eq(shipmentAllocationsTable.dealerId, dealerId), eq(shipmentAllocationsTable.shipmentId, id)))
    .orderBy(shipmentAllocationsTable.baselineAt, shipmentAllocationsTable.id);
  res.json(await allocationViews(db, dealerId, rows));
}));

router.post("/shipments/:shipmentId/allocations", h(async (req, res) => {
  const { dealerId, actor, user } = ctx(res);
  requirePerm(user, ALLOC_PERMS, "allocate shipment units to customers");
  const id = idParam(req, "shipmentId");
  const b = CreateShipmentAllocationBody.parse(req.body);
  if (b.specsConfirmed !== true)
    throw new HttpError(400, "Confirm the customer's exact specification (including interior) before allocating");
  const allocId = await db.transaction(async (tx) => {
    const ship = await loadShipment(tx, dealerId, id, true);
    await requireLease(tx, dealerId, id, user.id);
    const line = await lockedLine(tx, dealerId, b.lineId);
    if (line.shipmentId !== id) throw new HttpError(400, "Line is not on this shipment");
    const [spec] = await tx.select().from(shipmentSpecsTable).where(eq(shipmentSpecsTable.id, line.specId));
    if (!spec || spec.status !== "approved") throw new HttpError(409, "Specification is not approved");
    const lead = await eligibleLead(tx, dealerId, b.leadId);
    const deal = await checkDeal(tx, dealerId, lead.id, b.dealId);
    const cap = await lineCapacity(tx, line, ship.status);
    const r = allocateCapacity(cap.lineQuantity, cap.allocated, b.requestedQuantity, b.partialConsent === true);
    if (!r.ok) throw new HttpError(409, r.reason, "capacity");
    const now = new Date();
    const [row] = await tx
      .insert(shipmentAllocationsTable)
      .values({
        dealerId,
        shipmentId: id,
        shipmentLineId: line.id,
        specId: line.specId,
        leadId: lead.id,
        dealId: deal?.id ?? null,
        requestedQuantity: b.requestedQuantity,
        quantity: r.quantity,
        partialConsent: b.partialConsent === true,
        status: "active",
        baselineAt: now,
        baselineEtaMonth: ship.currentEtaMonth,
        specsConfirmedBy: actor,
        createdBy: actor,
      })
      .returning({ id: shipmentAllocationsTable.id });
    await queueInitialEmail(tx, { dealerId, shipmentId: id, allocationId: row!.id, etaMonth: ship.currentEtaMonth });
    await recordEvent(tx, {
      dealerId,
      shipmentId: id,
      allocationId: row!.id,
      kind: "vehicle_allocated",
      detail: `${r.quantity}${r.partial ? ` of ${b.requestedQuantity} (partial consent)` : ""} x ${specLabel(spec)} allocated to ${lead.name}; ETA ${ship.currentEtaMonth}. See communication status for email delivery.`,
      actor,
    });
    return row!.id;
  });
  const rows = await db.select().from(shipmentAllocationsTable).where(eq(shipmentAllocationsTable.id, allocId));
  res.status(201).json((await allocationViews(db, dealerId, rows))[0]);
}));

async function lockedAllocation(tx: Tx, dealerId: number, allocationId: number) {
  const [a] = await tx
    .select()
    .from(shipmentAllocationsTable)
    .where(and(eq(shipmentAllocationsTable.id, allocationId), eq(shipmentAllocationsTable.dealerId, dealerId)))
    .for("update");
  if (!a) throw new HttpError(404, "Allocation not found");
  if (a.status !== "active") throw new HttpError(409, `Allocation is ${a.status}`);
  return a;
}

router.post("/shipments/allocations/:allocationId/release", h(async (req, res) => {
  const { dealerId, actor, user } = ctx(res);
  requirePerm(user, ALLOC_PERMS, "release shipment allocations");
  const allocationId = idParam(req, "allocationId");
  const { reason } = ReleaseShipmentAllocationBody.parse(req.body);
  await db.transaction(async (tx) => {
    const pre = await lockedAllocation(tx, dealerId, allocationId);
    await loadShipment(tx, dealerId, pre.shipmentId, true);
    await requireLease(tx, dealerId, pre.shipmentId, user.id);
    const held = await liveConfirmedHolds(tx, allocationId);
    if (held > 0)
      throw new HttpError(409, `${held} confirmed VIN(s) are held for this customer - release the reservation hold on the deal first so the claim ledger stays accurate`);
    await supersedePending(tx, allocationId, "Allocation released", actor);
    await tx
      .update(shipmentAllocationsTable)
      .set({ status: "released", releasedReason: reason.trim(), releasedAt: new Date() })
      .where(eq(shipmentAllocationsTable.id, allocationId));
    await recordEvent(tx, { dealerId, shipmentId: pre.shipmentId, allocationId, kind: "allocation_released", detail: `Released ${pre.quantity} unit(s): ${reason.trim()}`, actor });
  });
  const rows = await db.select().from(shipmentAllocationsTable).where(eq(shipmentAllocationsTable.id, allocationId));
  res.json((await allocationViews(db, dealerId, rows))[0]);
}));

router.post("/shipments/allocations/:allocationId/reassign", h(async (req, res) => {
  const { dealerId, actor, user } = ctx(res);
  requirePerm(user, ALLOC_PERMS, "reassign shipment allocations");
  const allocationId = idParam(req, "allocationId");
  const { targetLineId } = ReassignShipmentAllocationBody.parse(req.body);
  const newId = await db.transaction(async (tx) => {
    const old = await lockedAllocation(tx, dealerId, allocationId);
    const [targetLineRef] = await tx
      .select({ shipmentId: shipmentLinesTable.shipmentId })
      .from(shipmentLinesTable)
      .where(and(eq(shipmentLinesTable.id, targetLineId), eq(shipmentLinesTable.dealerId, dealerId)));
    if (!targetLineRef) throw new HttpError(404, "Target line not found");
    if (targetLineId === old.shipmentLineId) throw new HttpError(400, "Target is the current line");
    // Lock shipments in id order to avoid deadlocks.
    const shipIds = [...new Set([old.shipmentId, targetLineRef.shipmentId])].sort((x, y) => x - y);
    for (const sid of shipIds) await loadShipment(tx, dealerId, sid, true);
    await requireLease(tx, dealerId, old.shipmentId, user.id);
    if (targetLineRef.shipmentId !== old.shipmentId) {
      const [lock] = await tx
        .select()
        .from(shipmentEditLocksTable)
        .where(and(eq(shipmentEditLocksTable.shipmentId, targetLineRef.shipmentId), eq(shipmentEditLocksTable.dealerId, dealerId)))
        .for("update");
      if (evaluateLease(lock, user.id, new Date()) === "other")
        throw new HttpError(423, `Target shipment is being edited by ${lock!.holderName}`, "locked");
    }
    const held = await liveConfirmedHolds(tx, allocationId);
    if (held > 0)
      throw new HttpError(409, `${held} confirmed VIN(s) are held for this customer - reassignment would orphan the hold. Release it on the deal first.`);
    const target = await lockedLine(tx, dealerId, targetLineId);
    if (target.specId !== old.specId)
      throw new HttpError(409, "Target line has a different specification - exact spec only");
    const [targetShip] = await tx.select().from(shipmentsTable).where(eq(shipmentsTable.id, target.shipmentId));
    await eligibleLead(tx, dealerId, old.leadId);
    const cap = await lineCapacity(tx, target, targetShip!.status);
    const r = allocateCapacity(cap.lineQuantity, cap.allocated, old.requestedQuantity, old.partialConsent);
    if (!r.ok) throw new HttpError(409, `Target cannot take this allocation: ${r.reason}. The original allocation is unchanged.`, "capacity");
    if (!old.partialConsent && r.quantity !== old.quantity)
      throw new HttpError(409, "Target cannot take the full allocation; original unchanged");
    await supersedePending(tx, allocationId, "Allocation reassigned", actor);
    // Release old first so the (lead, spec) active-unique index permits the successor.
    await tx
      .update(shipmentAllocationsTable)
      .set({ status: "reassigned", releasedReason: `Reassigned to line #${target.id}`, releasedAt: new Date() })
      .where(eq(shipmentAllocationsTable.id, allocationId));
    const [row] = await tx
      .insert(shipmentAllocationsTable)
      .values({
        dealerId,
        shipmentId: target.shipmentId,
        shipmentLineId: target.id,
        specId: target.specId,
        leadId: old.leadId,
        dealId: old.dealId,
        requestedQuantity: old.requestedQuantity,
        quantity: r.quantity,
        partialConsent: old.partialConsent,
        status: "active",
        baselineAt: old.baselineAt, // original priority preserved
        baselineEtaMonth: old.baselineEtaMonth,
        specsConfirmedBy: old.specsConfirmedBy,
        reassignedFromId: old.id,
        createdBy: actor,
      })
      .returning({ id: shipmentAllocationsTable.id });
    await queueInitialEmail(tx, { dealerId, shipmentId: target.shipmentId, allocationId: row!.id, etaMonth: targetShip!.currentEtaMonth });
    const detail = `Allocation #${old.id} moved to ${targetShip!.reference} line #${target.id} as #${row!.id} (priority kept)`;
    await recordEvent(tx, { dealerId, shipmentId: old.shipmentId, allocationId: old.id, kind: "allocation_reassigned", detail, actor });
    if (target.shipmentId !== old.shipmentId)
      await recordEvent(tx, { dealerId, shipmentId: target.shipmentId, allocationId: row!.id, kind: "allocation_reassigned_in", detail, actor });
    return row!.id;
  });
  const rows = await db.select().from(shipmentAllocationsTable).where(eq(shipmentAllocationsTable.id, newId));
  res.json((await allocationViews(db, dealerId, rows))[0]);
}));

export default router;
