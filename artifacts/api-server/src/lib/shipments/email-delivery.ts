import { and, eq } from "drizzle-orm";
import { db, emailLogsTable, shipmentEmailJobsTable, shipmentAllocationsTable, shipmentsTable, type EmailLog } from "@workspace/db";
import { shipmentEmailEligible } from "./rules";
import { dealerTimezone } from "../timezone";

/** Hold the same shipment row lock as edits through SMTP handoff. */
export async function withShipmentEmailDelivery<T>(item: Pick<EmailLog, "id" | "dealerId" | "leadId" | "payload"> & { template?: string }, work: () => Promise<T>): Promise<T | undefined> {
  if (!["shipment.allocated", "shipment.eta.changed"].includes(item.template ?? "")) return work();
  if (item.payload?.__shipmentTemplateTest === "1") return work();
  const id = Number(item.payload?.shipmentJobId);
  const cancel = async (reason: string) => {
    await db.update(emailLogsTable).set({ status: "cancelled", lastError: reason })
      .where(and(eq(emailLogsTable.id, item.id), eq(emailLogsTable.status, "sending")));
  };
  const [job] = await db.select().from(shipmentEmailJobsTable)
    .where(and(eq(shipmentEmailJobsTable.id, Number.isSafeInteger(id) ? id : -1), eq(shipmentEmailJobsTable.dealerId, item.dealerId)));
  if (!job) { await cancel("Shipment notification has no valid source event"); return; }
  return db.transaction(async tx => {
    const [ship] = await tx.select().from(shipmentsTable)
      .where(and(eq(shipmentsTable.id, job.shipmentId), eq(shipmentsTable.dealerId, item.dealerId))).for("update");
    const [current] = await tx.select().from(shipmentEmailJobsTable).where(eq(shipmentEmailJobsTable.id, job.id));
    const [allocation] = await tx.select().from(shipmentAllocationsTable)
      .where(and(eq(shipmentAllocationsTable.id, job.allocationId), eq(shipmentAllocationsTable.dealerId, item.dealerId)));
    const eligible = shipmentEmailEligible({
      production: process.env.NODE_ENV === "production", shipmentStatus: ship?.status,
      allocationStatus: allocation?.status, jobStatus: current?.status,
      currentEta: ship?.currentEtaMonth, eventEta: job.etaMonth,
      leadMatches: !!allocation && item.leadId === allocation.leadId,
      kind: job.kind, now: new Date(), timezone: await dealerTimezone(item.dealerId),
    });
    if (!eligible) {
      await cancel("Shipment notification superseded, inactive, outside its ETA window, or sending disabled in development");
      await tx.update(shipmentEmailJobsTable).set({ status: "superseded", reason: "Notification no longer eligible at delivery time" }).where(eq(shipmentEmailJobsTable.id, job.id));
      return;
    }
    return work();
  });
}
