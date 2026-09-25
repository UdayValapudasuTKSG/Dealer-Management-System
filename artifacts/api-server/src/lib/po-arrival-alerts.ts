import { and, eq, sql } from "drizzle-orm";
import { purchaseOrdersTable, purchaseOrderLinesTable, partsTable, inventoryLocationsTable, serviceOrdersTable, jobCardsTable, customersTable, partNotificationDeliveriesTable } from "@workspace/db";
import { owned, type PartsTx, operationAudit } from "./parts-operations";

/** Transactional outbox writes only. Receipt identity makes replay a no-op. */
export async function queuePoArrivalAlerts(tx: PartsTx, input: { dealerId: number; purchaseOrderId: number; actorId?: number; receiptId: number; received: { lineId: number; quantity: number }[] }) {
  const po = await owned(tx, purchaseOrdersTable, input.dealerId, input.purchaseOrderId);
  if (!po.locationId) return; // Historical unscoped POs cannot safely target a branch.
  const branch = await owned(tx, inventoryLocationsTable, input.dealerId, po.locationId);
  const rows = await tx.execute(sql`select * from po_communication_settings where dealer_id=${input.dealerId} and location_id=${po.locationId}`);
  const settings = rows.rows[0] ?? { sms_enabled: false, parts_manager: true, service_manager: true, customer_sms: false };
  // Existing dealer memberships are dealer-wide (no branch user assignment model).
  // Recipients are resolved from the selected dealer only; settings and events
  // remain tied to the concrete inventory location of this receipt.
  const managers = await tx.execute(sql`select u.id,u.phone,r.name from dealer_users m join users u on u.id=m.user_id join roles r on r.id=m.role_id where m.dealer_id=${input.dealerId} and u.status='active' and lower(replace(r.name,'_',' ')) in ('parts manager','service manager')`);
  for (const received of input.received) {
    if (received.quantity <= 0) continue;
    const line = await owned(tx, purchaseOrderLinesTable, input.dealerId, received.lineId);
    if (line.purchaseOrderId !== po.id || !line.isSpecialOrder) continue;
    const jobId = line.jobCardId ?? po.jobCardId;
    const job = jobId ? await owned(tx, jobCardsTable, input.dealerId, jobId) : null;
    const service = job?.serviceOrderId ? await owned(tx, serviceOrdersTable, input.dealerId, job.serviceOrderId) : null;
    const customerId = line.customerId ?? service?.customerId;
    const customer = customerId ? await owned(tx, customersTable, input.dealerId, customerId) : null;
    const part = line.partId ? await owned(tx, partsTable, input.dealerId, line.partId) : null;
    const advisor = po.advisorId ?? po.createdBy;
    const recipientIds = new Set<number>(advisor ? [advisor] : []);
    for (const manager of managers.rows) {
      const role = String(manager.name).toLowerCase().replaceAll("_", " ");
      if ((role === "parts manager" && settings.parts_manager) || (role === "service manager" && settings.service_manager)) recipientIds.add(Number(manager.id));
    }
    const body = `Special-order part ${line.partName} (${part?.sku ?? "external"}) x${received.quantity} received for ${customer?.name ?? service?.customerName ?? "Unlinked customer"} / RO ${service?.id ?? job?.id ?? "unlinked"} at ${branch.name}.`;
    const referenceId = `${po.id}:receipt:${input.receiptId}:line:${line.id}`;
    for (const recipientId of recipientIds) {
      const member = await tx.execute(sql`select u.phone from dealer_users m join users u on u.id=m.user_id where m.dealer_id=${input.dealerId} and m.user_id=${recipientId} and u.status='active'`);
      if (!member.rows.length) continue;
      const channels = settings.sms_enabled && member.rows[0].phone ? ["internal", "sms"] : ["internal"];
      for (const channel of channels) await tx.insert(partNotificationDeliveriesTable).values({ dealerId: input.dealerId, locationId: po.locationId, recipientId, channel, type: "special_order.received", referenceType: "purchase_order_line", referenceId, payload: { locationId: po.locationId, purchaseOrderId: po.id, purchaseOrderLineId: line.id, receiptId: input.receiptId, title: "Special-order part received", body } }).onConflictDoNothing();
    }
    if (settings.sms_enabled && settings.customer_sms && customer?.phone) await tx.insert(partNotificationDeliveriesTable).values({ dealerId: input.dealerId, locationId: po.locationId, recipientId: 0, channel: "sms", type: "special_order.received", referenceType: "purchase_order_line", referenceId: `${referenceId}:customer:${customer.id}`, payload: { locationId: po.locationId, purchaseOrderId: po.id, purchaseOrderLineId: line.id, receiptId: input.receiptId, customerId: customer.id, title: "Special-order part received", body } }).onConflictDoNothing();
    await operationAudit(tx, input.dealerId, input.actorId ?? null, "purchase_order_line", line.id, "Queued special-order arrival alerts", { receiptId: input.receiptId, locationId: po.locationId, quantity: received.quantity, recipientIds: [...recipientIds] });
  }
}