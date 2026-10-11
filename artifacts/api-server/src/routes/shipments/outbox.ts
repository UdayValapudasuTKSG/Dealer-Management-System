import { and, eq, inArray, ne } from "drizzle-orm";
import { dealerTimezone } from "../../lib/timezone";
import { shipmentEmailJobsTable, shipmentAllocationsTable, shipmentsTable, shipmentSpecsTable, leadsTable } from "@workspace/db";
import { enqueueEmail } from "../../lib/email";
import { specLabel } from "../../lib/shipments/rules";
import { TEMPLATE_WITHHELD_REASON, etaChangeWithinWindow } from "../../lib/shipments/rules";
import type { Tx } from "./common";

/**
 * New production events enqueue atomically into the dealer email outbox.
 * Development events remain withheld. No historical catch-up/backfill runs.
 */
export const SHIPMENT_EMAIL_SENDING_ENABLED = process.env.NODE_ENV === "production";

async function enqueueJob(tx: Tx, job: typeof shipmentEmailJobsTable.$inferSelect) {
  if (job.status !== "queued") return;
  const [record] = await tx.select({ a: shipmentAllocationsTable, s: shipmentsTable, spec: shipmentSpecsTable, lead: leadsTable })
    .from(shipmentAllocationsTable)
    .innerJoin(shipmentsTable, eq(shipmentsTable.id, shipmentAllocationsTable.shipmentId))
    .innerJoin(shipmentSpecsTable, eq(shipmentSpecsTable.id, shipmentAllocationsTable.specId))
    .innerJoin(leadsTable, eq(leadsTable.id, shipmentAllocationsTable.leadId))
    .where(and(eq(shipmentAllocationsTable.id, job.allocationId), eq(shipmentAllocationsTable.dealerId, job.dealerId),
      eq(shipmentsTable.dealerId, job.dealerId), eq(shipmentSpecsTable.dealerId, job.dealerId), eq(leadsTable.dealerId, job.dealerId)));
  if (!record?.lead.email || record.lead.deletedAt) {
    await tx.update(shipmentEmailJobsTable).set({ status: "suppressed", reason: "Customer has no usable email address or is archived" }).where(eq(shipmentEmailJobsTable.id, job.id));
    return;
  }
  const email = await enqueueEmail({
    dealerId: job.dealerId, leadId: record.lead.id, customerId: record.lead.customerId,
    template: job.kind === "initial" ? "shipment.allocated" : "shipment.eta.changed",
    to: record.lead.email, tx, deferProcessing: true,
    dedupeKey: `shipment-email:${job.dealerId}:${job.id}`,
    data: { shipmentJobId: String(job.id), customerName: record.lead.name,
      quantity: String(record.a.quantity), specification: specLabel(record.spec),
      shipmentReference: record.s.reference,
      etaLabel: new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${job.etaMonth}-01T12:00:00Z`)) },
  });
  if (email.status === "cancelled") {
    await tx.update(shipmentEmailJobsTable).set({ status: "suppressed", reason: "Customer communication preferences or import policy prevent delivery" }).where(eq(shipmentEmailJobsTable.id, job.id));
  }
}

export async function queueInitialEmail(
  tx: Tx,
  a: { dealerId: number; shipmentId: number; allocationId: number; etaMonth: string },
) {
  const [job] = await tx.insert(shipmentEmailJobsTable).values({
    ...a,
    kind: "initial",
    status: SHIPMENT_EMAIL_SENDING_ENABLED ? "queued" : "withheld",
    reason: SHIPMENT_EMAIL_SENDING_ENABLED ? "Queued for delivery" : TEMPLATE_WITHHELD_REASON,
  }).returning();
  await enqueueJob(tx, job!);
}

/** ETA change: supersede stale pending jobs, then apply the window rule. */
export async function queueEtaChangeEmail(
  tx: Tx,
  a: { dealerId: number; shipmentId: number; allocationId: number; etaMonth: string },
  now = new Date(),
): Promise<"withheld" | "suppressed" | "queued"> {
  const within = etaChangeWithinWindow(a.etaMonth, now, await dealerTimezone(a.dealerId));
  const status = !within ? "suppressed" : SHIPMENT_EMAIL_SENDING_ENABLED ? "queued" : "withheld";
  const reason = !within
    ? `Logged only: revised ETA ${a.etaMonth} is outside the current/next dealership calendar month, so no customer email is queued.`
    : SHIPMENT_EMAIL_SENDING_ENABLED
      ? "Queued for delivery"
      : TEMPLATE_WITHHELD_REASON;
  const [job] = await tx
    .insert(shipmentEmailJobsTable)
    .values({ ...a, kind: "eta_change", status, reason })
    .returning();
  await tx
    .update(shipmentEmailJobsTable)
    .set({ status: "superseded", supersededById: job!.id, reason: `Superseded by a newer ETA (${a.etaMonth}) before sending` })
    .where(and(
      eq(shipmentEmailJobsTable.dealerId, a.dealerId),
      eq(shipmentEmailJobsTable.allocationId, a.allocationId),
      eq(shipmentEmailJobsTable.kind, "eta_change"),
      inArray(shipmentEmailJobsTable.status, ["queued", "withheld"]),
      ne(shipmentEmailJobsTable.id, job!.id),
    ));
  await enqueueJob(tx, job!);
  return status;
}
