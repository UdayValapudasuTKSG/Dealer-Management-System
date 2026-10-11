import { Router, type IRouter } from "express";
import { randomInt } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  db,
  dealItemsTable,
  leadsTable,
  reservationAllocationsTable,
  shipmentAllocationsTable,
  shipmentEmailJobsTable,
  shipmentLinesTable,
  shipmentManifestsTable,
  shipmentMatchProposalsTable,
  shipmentMatchRunsTable,
  shipmentsTable,
  vehiclesTable,
  type ShipmentAllocation,
} from "@workspace/db";
import { ConfirmShipmentProposalBody, RejectShipmentProposalBody } from "@workspace/api-zod";
import { holdSpecificVehiclesForDeal, SpecificHoldRefused } from "../../lib/reservation-allocations";
import { NA, planGroupMatches, type DemandUnit } from "../../lib/shipments/rules";
import { type DbLike, HttpError, type Tx, ctx, h, idParam, loadShipment, recordEvent, requireLease, requirePerm, specOut, specsById } from "./common";

const router: IRouter = Router();
const rng = () => randomInt(0, 2 ** 31) / 2 ** 31;
const LIVE_LEDGER = ["active", "finalized"];

/**
 * Reconcile confirmed proposals whose reservation hold was released or
 * expired: the proposal is superseded (with a visible reason), the VIN
 * returns to matching and the allocation goes back to active. Nothing is
 * left falsely shown as confirmed/fulfilled.
 */
async function reconcileLapsedHolds(tx: Tx, dealerId: number, shipmentId: number, actor: string) {
  const lapsed = await tx
    .select({ p: shipmentMatchProposalsTable, ledger: reservationAllocationsTable.status })
    .from(shipmentMatchProposalsTable)
    .leftJoin(reservationAllocationsTable, eq(reservationAllocationsTable.id, shipmentMatchProposalsTable.reservationAllocationId))
    .where(and(
      eq(shipmentMatchProposalsTable.dealerId, dealerId),
      eq(shipmentMatchProposalsTable.shipmentId, shipmentId),
      eq(shipmentMatchProposalsTable.status, "confirmed"),
    ));
  const gone = lapsed.filter((r) => !r.ledger || !LIVE_LEDGER.includes(r.ledger));
  for (const { p } of gone) {
    await tx
      .update(shipmentMatchProposalsTable)
      .set({ status: "superseded", lastBlockedReason: "Reservation hold was released or expired - VIN returned to matching" })
      .where(eq(shipmentMatchProposalsTable.id, p.id));
    await tx.update(shipmentManifestsTable).set({ status: "unmatched" }).where(eq(shipmentManifestsTable.id, p.manifestId));
    await tx
      .update(shipmentAllocationsTable)
      .set({ status: "active" })
      .where(and(eq(shipmentAllocationsTable.id, p.allocationId), eq(shipmentAllocationsTable.status, "fulfilled")));
    await recordEvent(tx, { dealerId, shipmentId, allocationId: p.allocationId, kind: "hold_lapsed", detail: `Proposal #${p.id}: reservation hold no longer active; VIN returned to matching`, actor });
  }
  return gone.length;
}

type Counts = Map<number, { pending: number; confirmed: number }>;
async function proposalCounts(tx: DbLike, allocationIds: number[]): Promise<Counts> {
  const m: Counts = new Map();
  if (!allocationIds.length) return m;
  const rows = await tx
    .select({
      allocationId: shipmentMatchProposalsTable.allocationId,
      pending: sql<number>`count(*) filter (where ${shipmentMatchProposalsTable.status} = 'pending')::int`,
      confirmed: sql<number>`count(*) filter (where ${shipmentMatchProposalsTable.status} = 'confirmed' and ${reservationAllocationsTable.status} in ('active','finalized'))::int`,
    })
    .from(shipmentMatchProposalsTable)
    .leftJoin(reservationAllocationsTable, eq(reservationAllocationsTable.id, shipmentMatchProposalsTable.reservationAllocationId))
    .where(inArray(shipmentMatchProposalsTable.allocationId, allocationIds))
    .groupBy(shipmentMatchProposalsTable.allocationId);
  for (const r of rows) m.set(r.allocationId, { pending: r.pending, confirmed: r.confirmed });
  return m;
}

/** Pending shortages derived from current state, in priority order per spec. */
function deriveShortages(allocs: ShipmentAllocation[], counts: Counts) {
  const bySpec = new Map<number, ShipmentAllocation[]>();
  for (const a of allocs) bySpec.set(a.specId, [...(bySpec.get(a.specId) ?? []), a]);
  const out: { allocation: ShipmentAllocation; unitsShort: number; reason: string }[] = [];
  for (const group of bySpec.values()) {
    group.sort((x, y) => x.baselineAt.getTime() - y.baselineAt.getTime() || x.id - y.id);
    let blocker: number | null = null;
    for (const a of group) {
      const c = counts.get(a.id) ?? { pending: 0, confirmed: 0 };
      const short = a.quantity - c.pending - c.confirmed;
      if (short <= 0) continue;
      out.push({
        allocation: a,
        unitsShort: short,
        reason: blocker != null
          ? `Waiting behind older allocation #${blocker} - shortages cannot bypass earlier priority`
          : `${short} unit(s) still awaiting a matching manifest VIN`,
      });
      if (blocker == null) blocker = a.id;
    }
  }
  return out;
}

async function matchingView(tx: DbLike, dealerId: number, shipmentId: number) {
  const props = await tx
    .select({ p: shipmentMatchProposalsTable, vin: shipmentManifestsTable.vin, a: shipmentAllocationsTable, leadName: leadsTable.name, ledger: reservationAllocationsTable.status })
    .from(shipmentMatchProposalsTable)
    .innerJoin(shipmentManifestsTable, eq(shipmentManifestsTable.id, shipmentMatchProposalsTable.manifestId))
    .innerJoin(shipmentAllocationsTable, eq(shipmentAllocationsTable.id, shipmentMatchProposalsTable.allocationId))
    .leftJoin(leadsTable, eq(leadsTable.id, shipmentAllocationsTable.leadId))
    .leftJoin(reservationAllocationsTable, eq(reservationAllocationsTable.id, shipmentMatchProposalsTable.reservationAllocationId))
    .where(and(eq(shipmentMatchProposalsTable.dealerId, dealerId), eq(shipmentMatchProposalsTable.shipmentId, shipmentId)))
    .orderBy(desc(shipmentMatchProposalsTable.id))
    .limit(1000);
  const allocs = await tx
    .select()
    .from(shipmentAllocationsTable)
    .where(and(eq(shipmentAllocationsTable.dealerId, dealerId), eq(shipmentAllocationsTable.shipmentId, shipmentId), inArray(shipmentAllocationsTable.status, ["active", "fulfilled"])));
  const counts = await proposalCounts(tx, allocs.map((a) => a.id));
  const shortages = deriveShortages(allocs, counts);
  const leadIds = [...new Set(shortages.map((s) => s.allocation.leadId))];
  const leads = leadIds.length
    ? await tx.select({ id: leadsTable.id, name: leadsTable.name }).from(leadsTable).where(inArray(leadsTable.id, leadIds))
    : [];
  const ln = new Map(leads.map((l) => [l.id, l.name]));
  const specs = await specsById(tx, dealerId, [...props.map((p) => p.a.specId), ...shortages.map((s) => s.allocation.specId)]);
  const runs = await tx
    .select()
    .from(shipmentMatchRunsTable)
    .where(and(eq(shipmentMatchRunsTable.dealerId, dealerId), eq(shipmentMatchRunsTable.shipmentId, shipmentId)))
    .orderBy(desc(shipmentMatchRunsTable.id))
    .limit(20);
  return {
    proposals: props.map(({ p, vin, a, leadName, ledger }) => ({
      id: p.id,
      runId: p.runId,
      vin,
      manifestId: p.manifestId,
      allocationId: p.allocationId,
      leadId: a.leadId,
      leadName: leadName ?? `Lead #${a.leadId}`,
      dealId: a.dealId,
      spec: specOut(specs.get(a.specId)!, true),
      baselineAt: a.baselineAt,
      status: p.status as "pending" | "confirmed" | "superseded" | "rejected",
      lastBlockedReason: p.lastBlockedReason,
      holdStatus: p.status === "confirmed" ? (ledger ?? "released") : null,
      decidedBy: p.decidedBy,
      decidedAt: p.decidedAt,
      createdAt: p.createdAt,
    })),
    shortages: shortages.map((s) => ({
      allocationId: s.allocation.id,
      leadName: ln.get(s.allocation.leadId) ?? `Lead #${s.allocation.leadId}`,
      spec: specOut(specs.get(s.allocation.specId)!, true),
      baselineAt: s.allocation.baselineAt,
      unitsShort: s.unitsShort,
      reason: s.reason,
    })),
    runs,
  };
}

router.get("/shipments/:shipmentId/matching", h(async (req, res) => {
  const { dealerId } = ctx(res);
  const id = idParam(req, "shipmentId");
  await loadShipment(db, dealerId, id);
  res.json(await matchingView(db, dealerId, id));
}));

router.post("/shipments/:shipmentId/matching", h(async (req, res) => {
  const { dealerId, actor, user } = ctx(res);
  const id = idParam(req, "shipmentId");
  await db.transaction(async (tx) => {
    const ship = await loadShipment(tx, dealerId, id, true);
    await requireLease(tx, dealerId, id, user.id);
    if (ship.status === "cancelled") throw new HttpError(409, "Shipment is cancelled");
    await reconcileLapsedHolds(tx, dealerId, id, actor);
    const allocs = await tx
      .select()
      .from(shipmentAllocationsTable)
      .where(and(eq(shipmentAllocationsTable.dealerId, dealerId), eq(shipmentAllocationsTable.shipmentId, id), eq(shipmentAllocationsTable.status, "active")));
    const manifests = await tx
      .select()
      .from(shipmentManifestsTable)
      .where(and(eq(shipmentManifestsTable.dealerId, dealerId), eq(shipmentManifestsTable.shipmentId, id)));
    const pendingRows = await tx
      .select()
      .from(shipmentMatchProposalsTable)
      .where(and(eq(shipmentMatchProposalsTable.shipmentId, id), eq(shipmentMatchProposalsTable.status, "pending")));
    const counts = await proposalCounts(tx, allocs.map((a) => a.id));
    const specIds = [...new Set([...allocs.map((a) => a.specId), ...manifests.map((m) => m.specId)])];
    const [run] = await tx
      .insert(shipmentMatchRunsTable)
      .values({ dealerId, shipmentId: id, proposedCount: 0, shortageUnits: 0, unmatchedVins: 0, createdBy: actor })
      .returning();
    let proposed = 0;
    let shortageUnits = 0;
    let unmatched = 0;
    for (const specId of specIds) {
      const group = allocs.filter((a) => a.specId === specId);
      const groupIds = new Set(group.map((a) => a.id));
      const pending = pendingRows.filter((p) => groupIds.has(p.allocationId));
      // Incremental first: keep existing winners (retries never reshuffle).
      const keptManifest = new Set(pending.map((p) => p.manifestId));
      let free = manifests.filter((m) => m.specId === specId && m.status === "unmatched" && !keptManifest.has(m.id)).map((m) => m.id);
      const demandOf = (keepPending: boolean): DemandUnit[] =>
        group.map((a) => {
          const c = counts.get(a.id) ?? { pending: 0, confirmed: 0 };
          return { allocationId: a.id, baselineAt: a.baselineAt, partialConsent: a.partialConsent, remaining: a.quantity - c.confirmed - (keepPending ? c.pending : 0) };
        });
      let plan = planGroupMatches(free, demandOf(true), rng);
      // Priority check: a younger allocation must not hold pending VINs while an older one is short.
      const firstShort = plan.shortages.find((s) => !s.reason.startsWith("Waiting"));
      if (firstShort) {
        const blocker = group.find((a) => a.id === firstShort.allocationId)!;
        const leapfrog = pending.some((p) => {
          const a = group.find((g) => g.id === p.allocationId)!;
          return a.baselineAt.getTime() > blocker.baselineAt.getTime() || (a.baselineAt.getTime() === blocker.baselineAt.getTime() && a.id > blocker.id);
        });
        if (leapfrog) {
          await tx
            .update(shipmentMatchProposalsTable)
            .set({ status: "superseded", lastBlockedReason: "Superseded: re-planned to restore priority order", decidedBy: actor, decidedAt: new Date() })
            .where(inArray(shipmentMatchProposalsTable.id, pending.map((p) => p.id)));
          await tx
            .update(shipmentManifestsTable)
            .set({ status: "unmatched" })
            .where(inArray(shipmentManifestsTable.id, pending.map((p) => p.manifestId)));
          free = manifests.filter((m) => m.specId === specId && (m.status === "unmatched" || keptManifest.has(m.id))).map((m) => m.id);
          plan = planGroupMatches(free, demandOf(false), rng);
        }
      }
      for (const asg of plan.assignments) {
        await tx.insert(shipmentMatchProposalsTable).values({ dealerId, shipmentId: id, runId: run!.id, manifestId: asg.manifestId, allocationId: asg.allocationId, status: "pending" });
        await tx.update(shipmentManifestsTable).set({ status: "proposed" }).where(eq(shipmentManifestsTable.id, asg.manifestId));
      }
      proposed += plan.assignments.length;
      shortageUnits += plan.shortages.reduce((n, s) => n + s.unitsShort, 0);
      unmatched += plan.unmatchedManifestIds.length;
    }
    await tx
      .update(shipmentMatchRunsTable)
      .set({ proposedCount: proposed, shortageUnits, unmatchedVins: unmatched })
      .where(eq(shipmentMatchRunsTable.id, run!.id));
    await recordEvent(tx, { dealerId, shipmentId: id, kind: "matching_run", detail: `Run #${run!.id}: ${proposed} new proposal(s), ${shortageUnits} unit(s) short, ${unmatched} VIN(s) unmatched. Proposals are not holds.`, actor });
  });
  res.json(await matchingView(db, dealerId, id));
}));

const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();

type Blocked = { reason: string; handoff: "inventory_onboarding" | "reservation_payment" | "deal_link" | null };

router.post("/shipments/proposals/:proposalId/confirm", h(async (req, res) => {
  const { dealerId, actor, user } = ctx(res);
  requirePerm(user, [["deals", "approve"]], "confirm VIN matches");
  const proposalId = idParam(req, "proposalId");
  const { interiorVerified } = ConfirmShipmentProposalBody.parse(req.body);
  const result = await db.transaction(async (tx) => {
    const [p0] = await tx
      .select()
      .from(shipmentMatchProposalsTable)
      .where(and(eq(shipmentMatchProposalsTable.id, proposalId), eq(shipmentMatchProposalsTable.dealerId, dealerId)));
    if (!p0) throw new HttpError(404, "Proposal not found");
    await loadShipment(tx, dealerId, p0.shipmentId, true);
    await requireLease(tx, dealerId, p0.shipmentId, user.id);
    const [p] = await tx.select().from(shipmentMatchProposalsTable).where(eq(shipmentMatchProposalsTable.id, proposalId)).for("update");
    if (p!.status !== "pending") throw new HttpError(409, `Proposal is ${p!.status}`);
    const [alloc] = await tx.select().from(shipmentAllocationsTable).where(eq(shipmentAllocationsTable.id, p!.allocationId)).for("update");
    if (!alloc || alloc.status !== "active") throw new HttpError(409, "Allocation is no longer active");

    const block = async (b: Blocked, ids: number[]) => {
      await tx.update(shipmentMatchProposalsTable).set({ lastBlockedReason: b.reason }).where(inArray(shipmentMatchProposalsTable.id, ids));
      await recordEvent(tx, { dealerId, shipmentId: p!.shipmentId, allocationId: alloc.id, kind: "confirm_blocked", detail: `Proposal #${proposalId}: ${b.reason}`, actor });
      return { outcome: "blocked" as const, reason: b.reason, handoff: b.handoff, confirmedProposalIds: [] as number[] };
    };

    if (alloc.dealId == null)
      return block({ reason: "Link the customer's deal to this allocation before a VIN can be held", handoff: "deal_link" }, [p!.id]);
    // Match the reservation allocator's lock order BEFORE taking vehicle locks.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`reservation-alloc:${dealerId}:${alloc.dealId}`}))`);

    // Every active allocation for this deal, and all their pending proposals: the hold is all-or-nothing per deal.
    const dealAllocs = await tx
      .select()
      .from(shipmentAllocationsTable)
      .where(and(eq(shipmentAllocationsTable.dealerId, dealerId), eq(shipmentAllocationsTable.dealId, alloc.dealId), eq(shipmentAllocationsTable.status, "active")));
    const props = await tx
      .select({ p: shipmentMatchProposalsTable, vin: shipmentManifestsTable.vin, specId: shipmentManifestsTable.specId })
      .from(shipmentMatchProposalsTable)
      .innerJoin(shipmentManifestsTable, eq(shipmentManifestsTable.id, shipmentMatchProposalsTable.manifestId))
      .where(and(inArray(shipmentMatchProposalsTable.allocationId, dealAllocs.map((a) => a.id)), eq(shipmentMatchProposalsTable.status, "pending")))
      .for("update", { of: shipmentMatchProposalsTable });
    const ids = props.map((x) => x.p.id);
    const specs = await specsById(tx, dealerId, props.map((x) => x.specId));
    const vehicles: { proposalId: number; vehicleId: number; make: string; model: string; year: number; variant: string; color: string }[] = [];
    for (const x of props) {
      const spec = specs.get(x.specId)!;
      const [v] = await tx
        .select()
        .from(vehiclesTable)
        .where(and(eq(vehiclesTable.dealerId, dealerId), eq(vehiclesTable.vin, x.vin), isNull(vehiclesTable.deletedAt)))
        .for("update");
      if (!v)
        return block({ reason: `VIN ${x.vin} is not in inventory yet - onboard it through Inventory (real attributes from the factory record), then confirm again`, handoff: "inventory_onboarding" }, ids);
      if (v.status !== "available")
        return block({ reason: `VIN ${x.vin} is ${v.status} in inventory; existing claims are preserved`, handoff: null }, ids);
      const variant = v.trim ?? v.variant ?? "";
      const mismatch: string[] = [];
      if (norm(v.make) !== norm(spec.make)) mismatch.push("make");
      if (norm(v.model) !== norm(spec.model)) mismatch.push("model");
      if (v.year !== spec.year) mismatch.push("year");
      if (norm(variant) !== norm(spec.variant)) mismatch.push("variant (use explicit N/A if not applicable)");
      if (norm(v.exteriorColor) !== norm(spec.exteriorColor)) mismatch.push("exterior colour");
      if (mismatch.length)
        return block({ reason: `Inventory record for ${x.vin} differs from the approved spec (${mismatch.join(", ")}) - correct the inventory record, do not guess`, handoff: "inventory_onboarding" }, ids);
      if (spec.interiorColor !== NA && interiorVerified !== true)
        return block({ reason: `Inventory has no interior field - physically verify interior "${spec.interiorColor}" and tick the attestation`, handoff: null }, ids);
      vehicles.push({ proposalId: x.p.id, vehicleId: v.id, make: spec.make, model: spec.model, year: spec.year, variant: spec.variant, color: spec.exteriorColor });
    }
    // Map verified VINs onto every deal-item unit (exact spec).
    const items = await tx.select().from(dealItemsTable).where(and(eq(dealItemsTable.dealId, alloc.dealId), eq(dealItemsTable.dealerId, dealerId)));
    const unused = [...vehicles];
    const units: { dealItemId: number; dealItemUnit: number; vehicleId: number; proposalId: number }[] = [];
    for (const item of items)
      for (let u = 0; u < item.quantity; u += 1) {
        const i = unused.findIndex((v) =>
          norm(v.make) === norm(item.make) && norm(v.model) === norm(item.model) && v.year === item.modelYear &&
          (item.variant != null && norm(item.variant) === norm(v.variant)) && (item.color != null && norm(item.color) === norm(v.color)));
        if (i < 0)
          return block({ reason: `Deal #${alloc.dealId} needs every unit matched at once: no verified VIN for ${item.modelYear ?? ""} ${item.make ?? ""} ${item.model ?? ""} unit ${u + 1}. Run matching or adjust the deal.`, handoff: null }, ids);
        const [v] = unused.splice(i, 1);
        units.push({ dealItemId: item.id, dealItemUnit: u, vehicleId: v!.vehicleId, proposalId: v!.proposalId });
      }
    if (unused.length)
      return block({ reason: `${unused.length} proposed VIN(s) exceed the deal's units - reject the extra proposals`, handoff: null }, ids);

    let ledgerIds: number[];
    try {
      ledgerIds = await tx.transaction(async (sp) => (await holdSpecificVehiclesForDeal(sp, { dealerId, dealId: alloc.dealId!, units, actor })).allocationIds);
    } catch (err) {
      if (err instanceof SpecificHoldRefused) return block({ reason: err.message, handoff: err.handoff }, ids);
      throw err;
    }
    const now = new Date();
    for (let i = 0; i < units.length; i += 1) {
      const u = units[i]!;
      const pr = props.find((x) => x.p.id === u.proposalId)!;
      await tx
        .update(shipmentMatchProposalsTable)
        .set({ status: "confirmed", reservationAllocationId: ledgerIds[i]!, interiorVerified: interiorVerified === true, decidedBy: actor, decidedAt: now, lastBlockedReason: null })
        .where(eq(shipmentMatchProposalsTable.id, u.proposalId));
      await tx.update(shipmentManifestsTable).set({ status: "confirmed" }).where(eq(shipmentManifestsTable.id, pr.p.manifestId));
    }
    const counts = await proposalCounts(tx, dealAllocs.map((a) => a.id));
    for (const a of dealAllocs)
      if ((counts.get(a.id)?.confirmed ?? 0) >= a.quantity)
        await tx.update(shipmentAllocationsTable).set({ status: "fulfilled" }).where(eq(shipmentAllocationsTable.id, a.id));
    await recordEvent(tx, { dealerId, shipmentId: p!.shipmentId, allocationId: alloc.id, kind: "vins_confirmed", detail: `${units.length} VIN(s) held for deal #${alloc.dealId} via the reservation claim ledger`, actor });
    return { outcome: "confirmed" as const, reason: null, handoff: null, confirmedProposalIds: units.map((u) => u.proposalId) };
  });
  res.json(result);
}));

router.post("/shipments/proposals/:proposalId/reject", h(async (req, res) => {
  const { dealerId, actor, user } = ctx(res);
  const proposalId = idParam(req, "proposalId");
  const { reason } = RejectShipmentProposalBody.parse(req.body);
  const shipmentId = await db.transaction(async (tx) => {
    const [p0] = await tx
      .select()
      .from(shipmentMatchProposalsTable)
      .where(and(eq(shipmentMatchProposalsTable.id, proposalId), eq(shipmentMatchProposalsTable.dealerId, dealerId)));
    if (!p0) throw new HttpError(404, "Proposal not found");
    await loadShipment(tx, dealerId, p0.shipmentId, true);
    await requireLease(tx, dealerId, p0.shipmentId, user.id);
    const [p] = await tx.select().from(shipmentMatchProposalsTable).where(eq(shipmentMatchProposalsTable.id, proposalId)).for("update");
    if (p!.status !== "pending") throw new HttpError(409, `Proposal is ${p!.status}`);
    await tx
      .update(shipmentMatchProposalsTable)
      .set({ status: "rejected", lastBlockedReason: reason.trim(), decidedBy: actor, decidedAt: new Date() })
      .where(eq(shipmentMatchProposalsTable.id, proposalId));
    await tx.update(shipmentManifestsTable).set({ status: "unmatched" }).where(eq(shipmentManifestsTable.id, p!.manifestId));
    await recordEvent(tx, { dealerId, shipmentId: p!.shipmentId, allocationId: p!.allocationId, kind: "proposal_rejected", detail: `Proposal #${proposalId}: ${reason.trim()}`, actor });
    return p!.shipmentId;
  });
  res.json(await matchingView(db, dealerId, shipmentId));
}));

router.get("/shipments/exceptions", h(async (_req, res) => {
  const { dealerId } = ctx(res);
  const ships = await db
    .select()
    .from(shipmentsTable)
    .where(and(eq(shipmentsTable.dealerId, dealerId), inArray(shipmentsTable.status, ["open", "in_transit", "arrived"])));
  const out: { kind: string; shipmentId: number; shipmentReference: string; title: string; detail: string; refId: number }[] = [];
  for (const s of ships) {
    const view = await matchingView(db, dealerId, s.id);
    for (const sh of view.shortages)
      out.push({ kind: "shortage", shipmentId: s.id, shipmentReference: s.reference, title: `${sh.leadName}: ${sh.unitsShort} unit(s) short`, detail: sh.reason, refId: sh.allocationId });
    for (const p of view.proposals) {
      if (p.status === "pending" && p.lastBlockedReason)
        out.push({ kind: "blocked_proposal", shipmentId: s.id, shipmentReference: s.reference, title: `${p.vin} blocked for ${p.leadName}`, detail: p.lastBlockedReason, refId: p.id });
      if (p.status === "confirmed" && p.holdStatus && !LIVE_LEDGER.includes(p.holdStatus))
        out.push({ kind: "hold_lapsed", shipmentId: s.id, shipmentReference: s.reference, title: `${p.vin} hold ${p.holdStatus}`, detail: "Reservation hold no longer active - re-run matching to return the VIN", refId: p.id });
    }
    if (s.status === "arrived") {
      const um = await db
        .select({ id: shipmentManifestsTable.id, vin: shipmentManifestsTable.vin })
        .from(shipmentManifestsTable)
        .where(and(eq(shipmentManifestsTable.shipmentId, s.id), eq(shipmentManifestsTable.status, "unmatched")));
      for (const m of um)
        out.push({ kind: "unmatched_vin", shipmentId: s.id, shipmentReference: s.reference, title: `${m.vin} unmatched`, detail: "Arrived VIN with no proposal - available for reconciled allocation", refId: m.id });
    }
    if (s.status !== "open") {
      const lines = await db
        .select({ id: shipmentLinesTable.id, quantity: shipmentLinesTable.quantity, specId: shipmentLinesTable.specId, alloc: sql<number>`coalesce((select sum(quantity) from shipment_allocations sa where sa.shipment_line_id = ${shipmentLinesTable.id} and sa.status in ('active','fulfilled')),0)::int` })
        .from(shipmentLinesTable)
        .where(eq(shipmentLinesTable.shipmentId, s.id));
      for (const l of lines)
        if (l.quantity > l.alloc)
          out.push({ kind: "line_unallocated", shipmentId: s.id, shipmentReference: s.reference, title: `Line #${l.id}: ${l.quantity - l.alloc} unit(s) unallocated`, detail: `${s.status === "arrived" ? "Arrived" : "In transit"} with unclaimed capacity`, refId: l.id });
    }
  }
  const withheld = await db
    .select({ e: shipmentEmailJobsTable, ref: shipmentsTable.reference })
    .from(shipmentEmailJobsTable)
    .innerJoin(shipmentsTable, eq(shipmentsTable.id, shipmentEmailJobsTable.shipmentId))
    .where(and(eq(shipmentEmailJobsTable.dealerId, dealerId), eq(shipmentEmailJobsTable.status, "withheld")))
    .orderBy(desc(shipmentEmailJobsTable.id))
    .limit(200);
  for (const w of withheld)
    out.push({ kind: "withheld_email", shipmentId: w.e.shipmentId, shipmentReference: w.ref, title: `${w.e.kind === "initial" ? "Initial" : "ETA change"} email withheld (ETA ${w.e.etaMonth})`, detail: w.e.reason, refId: w.e.id });
  res.json(out);
}));

export default router;
