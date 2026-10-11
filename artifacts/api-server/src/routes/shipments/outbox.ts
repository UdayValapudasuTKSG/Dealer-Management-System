import { and, eq, inArray, ne } from "drizzle-orm";
import { dealerTimezone } from "../../lib/timezone";
import { shipmentEmailJobsTable } from "@workspace/db";
import { TEMPLATE_WITHHELD_REASON, etaChangeWithinWindow } from "../../lib/shipments/rules";
import type { Tx } from "./common";

/**
 * Customer-email outbox. Sending is DISABLED until template rollout is
 * approved: eligible jobs are persisted as `withheld` with a visible reason;
 * nothing is ever reported as sent. No real mail leaves this module.
 */
export const SHIPMENT_EMAIL_SENDING_ENABLED = false;

export async function queueInitialEmail(
  tx: Tx,
  a: { dealerId: number; shipmentId: number; allocationId: number; etaMonth: string },
) {
  await tx.insert(shipmentEmailJobsTable).values({
    ...a,
    kind: "initial",
    status: SHIPMENT_EMAIL_SENDING_ENABLED ? "queued" : "withheld",
    reason: SHIPMENT_EMAIL_SENDING_ENABLED ? "Queued for delivery" : TEMPLATE_WITHHELD_REASON,
  });
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
    .returning({ id: shipmentEmailJobsTable.id });
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
  return status;
}
