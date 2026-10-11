import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  leadsTable,
  reservationAllocationsTable,
  shipmentAllocationsTable,
  shipmentEditLocksTable,
  shipmentEmailJobsTable,
  emailLogsTable,
  shipmentLinesTable,
  shipmentManifestsTable,
  shipmentMatchProposalsTable,
  shipmentsTable,
  type Shipment,
  type ShipmentAllocation,
} from "@workspace/db";
import { ETA_EMAIL_RULE, evaluateLease } from "../../lib/shipments/rules";
import { type DbLike, HttpError, specOut, specsById } from "./common";

const LIVE_ALLOC = ["active", "fulfilled"];

export async function shipmentSummaries(tx: DbLike, dealerId: number, ships: Shipment[]) {
  if (!ships.length) return [];
  const ids = ships.map((s) => s.id);
  const lines = await tx
    .select({ shipmentId: shipmentLinesTable.shipmentId, units: sql<number>`sum(${shipmentLinesTable.quantity})::int` })
    .from(shipmentLinesTable)
    .where(and(eq(shipmentLinesTable.dealerId, dealerId), inArray(shipmentLinesTable.shipmentId, ids)))
    .groupBy(shipmentLinesTable.shipmentId);
  const allocs = await tx
    .select({ shipmentId: shipmentAllocationsTable.shipmentId, units: sql<number>`sum(${shipmentAllocationsTable.quantity})::int` })
    .from(shipmentAllocationsTable)
    .where(and(
      eq(shipmentAllocationsTable.dealerId, dealerId),
      inArray(shipmentAllocationsTable.shipmentId, ids),
      inArray(shipmentAllocationsTable.status, LIVE_ALLOC),
    ))
    .groupBy(shipmentAllocationsTable.shipmentId);
  const vins = await tx
    .select({
      shipmentId: shipmentManifestsTable.shipmentId,
      n: sql<number>`count(*)::int`,
      confirmed: sql<number>`count(*) filter (where ${shipmentManifestsTable.status} = 'confirmed')::int`,
    })
    .from(shipmentManifestsTable)
    .where(and(eq(shipmentManifestsTable.dealerId, dealerId), inArray(shipmentManifestsTable.shipmentId, ids)))
    .groupBy(shipmentManifestsTable.shipmentId);
  const lm = new Map(lines.map((r) => [r.shipmentId, r.units]));
  const am = new Map(allocs.map((r) => [r.shipmentId, r.units]));
  const vm = new Map(vins.map((r) => [r.shipmentId, r]));
  return ships.map((s) => ({
    id: s.id,
    reference: s.reference,
    status: s.status as "open" | "in_transit" | "arrived" | "closed" | "cancelled",
    baselineEtaMonth: s.baselineEtaMonth,
    currentEtaMonth: s.currentEtaMonth,
    notes: s.notes,
    totalUnits: lm.get(s.id) ?? 0,
    allocatedUnits: am.get(s.id) ?? 0,
    manifestVins: vm.get(s.id)?.n ?? 0,
    confirmedVins: vm.get(s.id)?.confirmed ?? 0,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  }));
}

export async function lockState(tx: DbLike, dealerId: number, shipmentId: number, userId: number) {
  const [lock] = await tx
    .select()
    .from(shipmentEditLocksTable)
    .where(and(eq(shipmentEditLocksTable.shipmentId, shipmentId), eq(shipmentEditLocksTable.dealerId, dealerId)));
  const state = evaluateLease(lock, userId, new Date());
  if (state === "free") return { held: false, holderName: null, expiresAt: null, viewerHolds: false };
  return { held: true, holderName: lock!.holderName, expiresAt: lock!.expiresAt, viewerHolds: state === "mine" };
}

export async function shipmentDetail(tx: DbLike, dealerId: number, shipmentId: number, userId: number) {
  const [ship] = await tx
    .select()
    .from(shipmentsTable)
    .where(and(eq(shipmentsTable.id, shipmentId), eq(shipmentsTable.dealerId, dealerId)));
  if (!ship) throw new HttpError(404, "Shipment not found");
  const [summary] = await shipmentSummaries(tx, dealerId, [ship]);
  const lines = await tx
    .select()
    .from(shipmentLinesTable)
    .where(and(eq(shipmentLinesTable.dealerId, dealerId), eq(shipmentLinesTable.shipmentId, shipmentId)))
    .orderBy(shipmentLinesTable.id);
  const allocs = await tx
    .select({ lineId: shipmentAllocationsTable.shipmentLineId, units: sql<number>`sum(${shipmentAllocationsTable.quantity})::int` })
    .from(shipmentAllocationsTable)
    .where(and(
      eq(shipmentAllocationsTable.dealerId, dealerId),
      eq(shipmentAllocationsTable.shipmentId, shipmentId),
      inArray(shipmentAllocationsTable.status, LIVE_ALLOC),
    ))
    .groupBy(shipmentAllocationsTable.shipmentLineId);
  const vins = await tx
    .select({ specId: shipmentManifestsTable.specId, n: sql<number>`count(*)::int` })
    .from(shipmentManifestsTable)
    .where(and(eq(shipmentManifestsTable.dealerId, dealerId), eq(shipmentManifestsTable.shipmentId, shipmentId)))
    .groupBy(shipmentManifestsTable.specId);
  const am = new Map(allocs.map((a) => [a.lineId, a.units]));
  const vm = new Map(vins.map((v) => [v.specId, v.n]));
  const specs = await specsById(tx, dealerId, lines.map((l) => l.specId));
  return {
    shipment: summary!,
    lines: lines.map((l) => {
      const allocated = am.get(l.id) ?? 0;
      return {
        id: l.id,
        specId: l.specId,
        spec: specOut(specs.get(l.specId)!, true),
        quantity: l.quantity,
        allocatedUnits: allocated,
        remainingUnits: Math.max(0, l.quantity - allocated),
        manifestVins: vm.get(l.specId) ?? 0,
      };
    }),
    lock: await lockState(tx, dealerId, shipmentId, userId),
    etaEmailRule: ETA_EMAIL_RULE,
  };
}

export async function allocationViews(tx: DbLike, dealerId: number, rows: ShipmentAllocation[]) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const ships = await tx
    .select()
    .from(shipmentsTable)
    .where(and(eq(shipmentsTable.dealerId, dealerId), inArray(shipmentsTable.id, [...new Set(rows.map((r) => r.shipmentId))])));
  const sm = new Map(ships.map((s) => [s.id, s]));
  const leads = await tx
    .select({ id: leadsTable.id, name: leadsTable.name })
    .from(leadsTable)
    .where(and(eq(leadsTable.dealerId, dealerId), inArray(leadsTable.id, [...new Set(rows.map((r) => r.leadId))])));
  const lm = new Map(leads.map((l) => [l.id, l.name]));
  const specs = await specsById(tx, dealerId, rows.map((r) => r.specId));
  const props = await tx
    .select({
      allocationId: shipmentMatchProposalsTable.allocationId,
      pending: sql<number>`count(*) filter (where ${shipmentMatchProposalsTable.status} = 'pending')::int`,
      confirmed: sql<number>`count(*) filter (where ${shipmentMatchProposalsTable.status} = 'confirmed' and ${reservationAllocationsTable.status} in ('active','finalized'))::int`,
      lapsed: sql<number>`count(*) filter (where ${shipmentMatchProposalsTable.status} = 'confirmed' and coalesce(${reservationAllocationsTable.status}, 'released') not in ('active','finalized'))::int`,
    })
    .from(shipmentMatchProposalsTable)
    .leftJoin(reservationAllocationsTable, eq(reservationAllocationsTable.id, shipmentMatchProposalsTable.reservationAllocationId))
    .where(and(eq(shipmentMatchProposalsTable.dealerId, dealerId), inArray(shipmentMatchProposalsTable.allocationId, ids)))
    .groupBy(shipmentMatchProposalsTable.allocationId);
  const pm = new Map(props.map((p) => [p.allocationId, p]));
  const emails = await tx
    .select()
    .from(shipmentEmailJobsTable)
    .where(and(eq(shipmentEmailJobsTable.dealerId, dealerId), inArray(shipmentEmailJobsTable.allocationId, ids)))
    .orderBy(desc(shipmentEmailJobsTable.createdAt), desc(shipmentEmailJobsTable.id));
  const em = new Map<number, typeof emails>();
  const deliveryRows = emails.length ? await tx.select().from(emailLogsTable).where(and(
    eq(emailLogsTable.dealerId, dealerId),
    inArray(emailLogsTable.dedupeKey, emails.map(e => `shipment-email:${dealerId}:${e.id}`)),
  )) : [];
  const deliveries = new Map(deliveryRows.map(e => [e.dedupeKey, e]));
  for (const email of emails) {
    const delivery = deliveries.get(`shipment-email:${dealerId}:${email.id}`);
    if (!delivery) continue;
    if (delivery.status === "sent") {
      email.status = "sent"; email.reason = "Accepted by the dealership email provider";
    } else if (delivery.status === "failed") {
      email.status = "failed"; email.reason = "Email delivery failed; see the email outbox for retry details";
    } else if (delivery.status === "cancelled") {
      email.status = email.status === "superseded" ? "superseded" : "suppressed";
      email.reason = "Delivery cancelled by current communication, shipment or sender policy";
    } else if (email.status === "queued") {
      email.reason = delivery.status === "sending" ? "Sending through dealership email provider" : "Waiting in dealership email outbox";
    }
  }
  for (const e of emails) em.set(e.allocationId, [...(em.get(e.allocationId) ?? []), e]);
  return rows.map((r) => {
    const s = sm.get(r.shipmentId);
    return {
      id: r.id,
      shipmentId: r.shipmentId,
      shipmentReference: s?.reference ?? "",
      shipmentStatus: s?.status ?? "",
      currentEtaMonth: s?.currentEtaMonth ?? r.baselineEtaMonth,
      baselineEtaMonth: r.baselineEtaMonth,
      lineId: r.shipmentLineId,
      spec: specOut(specs.get(r.specId)!, true),
      leadId: r.leadId,
      leadName: lm.get(r.leadId) ?? `Lead #${r.leadId}`,
      dealId: r.dealId,
      requestedQuantity: r.requestedQuantity,
      quantity: r.quantity,
      partialConsent: r.partialConsent,
      status: r.status as "active" | "fulfilled" | "released" | "reassigned",
      baselineAt: r.baselineAt,
      specsConfirmedBy: r.specsConfirmedBy,
      matchedUnits: pm.get(r.id)?.pending ?? 0,
      confirmedUnits: pm.get(r.id)?.confirmed ?? 0,
      holdLapsedUnits: pm.get(r.id)?.lapsed ?? 0,
      reassignedFromId: r.reassignedFromId,
      releasedReason: r.releasedReason,
      emails: (em.get(r.id) ?? []).map((e) => ({
        id: e.id,
        kind: e.kind as "initial" | "eta_change",
        etaMonth: e.etaMonth,
        status: e.status as "queued" | "withheld" | "suppressed" | "superseded" | "sent" | "failed",
        reason: e.reason,
        createdAt: e.createdAt,
      })),
      createdAt: r.createdAt,
    };
  });
}
