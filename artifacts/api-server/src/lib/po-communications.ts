import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, purchaseOrdersTable, purchaseOrderLinesTable, suppliersTable, dealersTable, usersTable, emailLogsTable } from "@workspace/db";
import { demand, owned, operationAudit, PartsOperationError } from "./parts-operations";
import { buildPurchaseOrderPdf } from "./purchase-order-pdf";
import { getDealerPdfBranding } from "./dealer-branding";
import { dealerTimezone } from "./timezone";
import { ObjectStorageService } from "./objectStorage";
import { resolveDealerSmtp, sanitizeSmtpError } from "./smtp-connection";
import { canEmailPo } from "./po-lifecycle-policy";
import { exactPoMail, type PoMailSnapshot } from "./po-delivery-policy";

const storage = new ObjectStorageService();
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export function poApprovalFingerprint(po: Record<string, unknown>, lines: Record<string, unknown>[]) {
  return hash(Buffer.from(JSON.stringify({ supplierId: po.supplierId, locationId: po.locationId, expectedDate: po.expectedDate, notes: po.notes, reviewedAt: po.reviewedAt, lines: [...lines].sort((a, b) => Number(a.id) - Number(b.id)).map(l => ({ id: l.id, partId: l.partId, partName: l.partName, quantity: l.quantity, unitCost: l.unitCost, landedCostComponents: l.landedCostComponents })) })));
}
const escaped = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export async function previewPoEmail(dealerId: number, actorId: number, id: number, resend: boolean) {
  const po = await owned(db, purchaseOrdersTable, dealerId, id);
  demand(canEmailPo(po.status, resend, !!po.sentAt || po.sendCount > 0), "Approve the PO before sending, or explicitly confirm resend");
  demand(po.supplierId, "Assign a supplier first");
  const supplier = await owned(db, suppliersTable, dealerId, po.supplierId);
  demand(supplier.email && supplier.status === "active", "Supplier needs an active email address");
  const [dealer] = await db.select().from(dealersTable).where(eq(dealersTable.id, dealerId));
  const [sender] = await db.select().from(usersTable).where(eq(usersTable.id, actorId));
  const lines = await db.select().from(purchaseOrderLinesTable).where(and(eq(purchaseOrderLinesTable.dealerId, dealerId), eq(purchaseOrderLinesTable.purchaseOrderId, id)));
  demand(lines.length, "PO has no lines");
  const settings = await db.execute(sql`select * from po_communication_settings where dealer_id=${dealerId} and location_id=${po.locationId}`);
  const location = await db.execute(sql`select name from inventory_locations where dealer_id=${dealerId} and id=${po.locationId}`);
  const tokens: Record<string, unknown> = { po_number: po.poNumber || po.reference || `PO-${id}`, supplier_name: supplier.name, branch: location.rows[0]?.name || dealer.name, expected_date: po.expectedDate || "Not specified", sender_name: sender?.name };
  const render = (s: string, html: boolean) => s.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => html ? escaped(tokens[key]) : String(tokens[key] ?? ""));
  const subject = render(String(settings.rows[0]?.subject || "Purchase order {{po_number}}"), false);
  const body = render(String(settings.rows[0]?.body_html || "<p>Dear {{supplier_name}},</p><p>Please find purchase order {{po_number}} attached for {{branch}}. Expected: {{expected_date}}.</p><p>{{sender_name}}</p>"), true);
  const ccResult = await db.execute(sql`select cc_emails from suppliers where dealer_id=${dealerId} and id=${supplier.id}`);
  const cc = [...new Set([...(ccResult.rows[0]?.cc_emails as string[] || []), sender?.email].filter(Boolean))].join(", ");
  const bytes = await buildPurchaseOrderPdf({ ...po, reference: po.poNumber || po.reference, lines }, dealer, supplier, await getDealerPdfBranding(dealerId), await dealerTimezone(dealerId));
  const upload = await storage.createPrivateUpload(`dealer-${dealerId}/location-${po.locationId ?? "legacy"}/purchase-orders/${id}`);
  const result = await fetch(upload.uploadUrl, { method: "PUT", headers: { "Content-Type": "application/pdf" }, body: new Uint8Array(bytes) });
  demand(result.ok, "Could not store the immutable PO PDF", 503);
  const filename = `purchase-order-${id}.pdf`;
  const saved = await db.execute(sql`insert into po_email_snapshots(dealer_id,location_id,purchase_order_id,created_by,object_path,sha256,filename,to_address,cc,subject,body_html,po_fingerprint) values(${dealerId},${po.locationId},${id},${actorId},${upload.objectPath},${hash(bytes)},${filename},${supplier.email},${cc},${subject},${body},${poApprovalFingerprint(po, lines)}) returning id`);
  return { id: Number(saved.rows[0].id), to: supplier.email, cc, subject, html: body, filename, sha256: hash(bytes) };
}
export async function poSnapshotPdf(dealerId: number, poId: number, snapshotId: number) {
  const rows = await db.execute(sql`select * from po_email_snapshots where dealer_id=${dealerId} and purchase_order_id=${poId} and id=${snapshotId}`);
  const snapshot = rows.rows[0];
  demand(snapshot, "PDF snapshot not found", 404);
  const file = await storage.getObjectEntityFile(String(snapshot.object_path));
  const [bytes] = await file.download();
  demand(hash(bytes) === snapshot.sha256, "PDF snapshot integrity check failed", 409);
  return bytes;
}
export async function sendPoPreview(dealerId: number, actorId: number, poId: number, input: { snapshotId: number; to: string; cc: string; subject: string; html: string; resend: boolean }) {
  return db.transaction(async tx => {
    const po = await owned(tx, purchaseOrdersTable, dealerId, poId, true);
    demand(canEmailPo(po.status, input.resend, !!po.sentAt || po.sendCount > 0), "Only approved POs can be sent; confirm resend for a sent PO");
    const snapshots = await tx.execute(sql`select * from po_email_snapshots where dealer_id=${dealerId} and purchase_order_id=${poId} and id=${input.snapshotId} for update`);
    const snapshot = snapshots.rows[0];
    demand(snapshot && snapshot.created_by === actorId, "Preview not found", 404);
    if (snapshot.email_log_id) {
      const [existing] = await tx.select().from(emailLogsTable).where(and(eq(emailLogsTable.dealerId, dealerId), eq(emailLogsTable.id, Number(snapshot.email_log_id))));
      return existing;
    }
    demand(!po.reviewedAt || new Date(String(snapshot.created_at)) >= new Date(po.reviewedAt), "Preview expired after a new review. Open Preview & send again");
    const currentLines = await tx.select().from(purchaseOrderLinesTable).where(and(eq(purchaseOrderLinesTable.dealerId, dealerId), eq(purchaseOrderLinesTable.purchaseOrderId, poId)));
    demand(snapshot.po_fingerprint === poApprovalFingerprint(po, currentLines), "PO changed since preview. Open Preview & send again");
    const busy = await tx.execute(sql`select e.id from po_email_snapshots s join email_logs e on e.id=s.email_log_id where s.dealer_id=${dealerId} and s.purchase_order_id=${poId} and e.status in ('queued','sending')`);
    demand(!busy.rows.length, "Delivery is queued or uncertain; investigate before resending");
    const [log] = await tx.insert(emailLogsTable).values({ dealerId, locationId: po.locationId, recipient: input.to, subject: input.subject, template: "parts.purchase_order", status: "queued", dedupeKey: `po-preview:${dealerId}:${input.snapshotId}`, payload: { snapshotId: String(input.snapshotId), purchaseOrderId: String(poId), actorId: String(actorId) } }).returning();
    await tx.execute(sql`update po_email_snapshots set email_log_id=${log.id},to_address=${input.to},cc=${input.cc},subject=${input.subject},body_html=${input.html} where dealer_id=${dealerId} and id=${input.snapshotId} and email_log_id is null`);
    await operationAudit(tx, dealerId, actorId, "purchase_order", poId, "Queued approved PO email", { before: po.status, after: po.status, emailLogId: log.id, snapshotId: input.snapshotId });
    return log;
  });
}
/** Called exclusively after the shared email worker's compare-and-set claim. */
export async function deliverClaimedPoEmail(item: typeof emailLogsTable.$inferSelect, testTransport?: {
  readPdf: typeof poSnapshotPdf;
  sendMail: (message: ReturnType<typeof exactPoMail>) => Promise<{ messageId: string }>;
}) {
  if (process.env.OUTBOX_WORKER_DISABLED === "1" && !testTransport) return;
  let accepted = false;
  let providerMessageId: string | undefined;
  try {
    const rows = await db.execute(sql`select * from po_email_snapshots where dealer_id=${item.dealerId} and email_log_id=${item.id}`);
    const snapshot = rows.rows[0];
    demand(snapshot, "PO snapshot missing");
    const po = await owned(db, purchaseOrdersTable, item.dealerId, Number(snapshot.purchase_order_id));
    demand(["approved", "sent", "ordered", "partially_received", "received"].includes(po.status), "PO no longer approved for delivery");
    const bytes = await (testTransport?.readPdf ?? poSnapshotPdf)(item.dealerId, po.id, Number(snapshot.id));
    const message = exactPoMail(snapshot as unknown as PoMailSnapshot, bytes);
    const response = testTransport ? await testTransport.sendMail(message) : await (async () => {
      const smtp = await resolveDealerSmtp(item.dealerId);
      demand(smtp.ok, "Dealer SMTP is disabled or not configured");
      return smtp.transport.sendMail({ from: smtp.fromName ? { name: smtp.fromName, address: smtp.fromEmail } : smtp.fromEmail, replyTo: smtp.replyTo ?? undefined, ...message });
    })();
    accepted = true;
    providerMessageId = response.messageId;
    demand(response.messageId, "Provider accepted mail without a message ID; investigate before retrying");
    if ("accepted" in response && Array.isArray(response.accepted)) {
      const recipients = response.accepted.map((value: unknown) => String(value).toLowerCase());
      demand(recipients.includes(String(snapshot.to_address).toLowerCase()), "Provider did not accept the supplier recipient; investigate partial delivery before retrying");
    }
    await db.transaction(async tx => {
      await tx.update(emailLogsTable).set({ status: "sent", sentAt: new Date(), providerMessageId: response.messageId, deliveryStatus: "accepted", lastError: null }).where(and(eq(emailLogsTable.dealerId, item.dealerId), eq(emailLogsTable.id, item.id), eq(emailLogsTable.status, "sending")));
      const current = await owned(tx, purchaseOrdersTable, item.dealerId, po.id, true);
      await tx.update(purchaseOrdersTable).set({ status: current.status === "approved" ? "sent" : current.status, sentAt: new Date(), sendCount: current.sendCount + 1 }).where(and(eq(purchaseOrdersTable.dealerId, item.dealerId), eq(purchaseOrdersTable.id, po.id), eq(purchaseOrdersTable.status, current.status)));
      await operationAudit(tx, item.dealerId, Number(item.payload.actorId), "purchase_order", po.id, "Supplier email accepted", { before: current.status, after: current.status === "approved" ? "sent" : current.status, emailLogId: item.id, providerMessageId: response.messageId });
    });
  } catch (error) {
    const status = accepted ? "sending" : "failed";
    const lastError = accepted ? "Provider may have accepted this email. Investigate before retrying." : error instanceof PartsOperationError ? error.message : sanitizeSmtpError(error).message;
    await db.transaction(async tx => {
      await tx.update(emailLogsTable).set({ status, attempts: 100, ...(providerMessageId ? { providerMessageId } : {}), lastError }).where(and(eq(emailLogsTable.dealerId, item.dealerId), eq(emailLogsTable.id, item.id)));
      await operationAudit(tx, item.dealerId, Number(item.payload.actorId) || null, "po_email", item.id, accepted ? "PO delivery requires investigation" : "PO email failed; approval retained", { before: "sending", after: status, providerMessageId, error: lastError });
    });
  }
}