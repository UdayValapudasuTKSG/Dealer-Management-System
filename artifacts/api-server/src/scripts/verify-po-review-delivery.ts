import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
if (process.env.NODE_ENV !== "development" || process.env.VERIFY_PO_REVIEW !== "1") throw new Error("Explicit development-only verification required");
const target = new URL(process.env.DATABASE_URL ?? process.env.DEV_DATABASE_URL ?? "");
if (!["helium", "localhost", "127.0.0.1"].includes(target.hostname)) throw new Error("Development host allowlist required");
process.env.OUTBOX_WORKER_DISABLED = "1";
const { db, pool, dealersTable, usersTable, suppliersTable, purchaseOrdersTable, purchaseOrderLinesTable, inventoryLocationsTable, partsTable, emailLogsTable, partNotificationDeliveriesTable, dealerUsersTable, rolesTable } = await import("@workspace/db");
const { eq, and, sql } = await import("drizzle-orm");
const { deliverClaimedPoEmail, sendPoPreview } = await import("../lib/po-communications");
const { queuePoArrivalAlerts } = await import("../lib/po-arrival-alerts");
const token = randomUUID();
const pdf = Buffer.from("%PDF-1.4\nmock verification only");
let dealerId: number | undefined, actorId: number | undefined;
try {
  const [dealer] = await db.insert(dealersTable).values({ name: `PO verification ${token}`, status: "suspended" }).returning();
  dealerId = dealer.id;
  const [actor] = await db.insert(usersTable).values({ clerkId: `po-test-${token}`, name: "PO test only", email: `${token}@example.invalid`, status: "active", phone: "+5926000000" }).returning();
  actorId = actor.id;
  const [role] = await db.select().from(rolesTable).limit(1);
  assert.ok(role, "Existing role definitions are required");
  await db.insert(dealerUsersTable).values({ dealerId, userId: actor.id, roleId: role.id });
  const [location] = await db.insert(inventoryLocationsTable).values({ dealerId, name: "Isolated verification branch", type: "branch" }).returning();
  const [supplier] = await db.insert(suppliersTable).values({ dealerId, name: "Isolated verification supplier", email: "supplier@example.invalid" }).returning();
  const [part] = await db.insert(partsTable).values({ dealerId, sku: `VERIFY-${token}`, name: "Verification special part" }).returning();
  const [po] = await db.insert(purchaseOrdersTable).values({ dealerId, locationId: location.id, supplierId: supplier.id, status: "approved", createdBy: actor.id }).returning();
  assert.match(po.poNumber!, /^PO-\d+-000001$/);
  const [line] = await db.insert(purchaseOrderLinesTable).values({ dealerId, purchaseOrderId: po.id, partId: part.id, partName: part.name, quantity: 2, qtyReceived: 1, isSpecialOrder: true }).returning();
  const snapshot = await db.execute(sql`insert into po_email_snapshots(dealer_id,location_id,purchase_order_id,created_by,object_path,sha256,filename,to_address,cc,subject,body_html) values(${dealerId},${location.id},${po.id},${actor.id},'/objects/test-no-file',${createHash("sha256").update(pdf).digest("hex")},'test.pdf','supplier@example.invalid','','Final subject','<p>Final HTML</p>') returning id`);
  const snapshotId = Number(snapshot.rows[0].id);
  // Use a far-future queue time before the transaction commits: no running
  // application worker can claim or send this isolated dealer's test email.
  const [log] = await db.insert(emailLogsTable).values({ dealerId, recipient: "supplier@example.invalid", subject: "Final subject", template: "parts.purchase_order", status: "sending", payload: { actorId: String(actor.id) }, attempts: 1 }).returning();
  await db.execute(sql`update po_email_snapshots set email_log_id=${log.id} where id=${snapshotId} and dealer_id=${dealerId}`);
  let mockCalls = 0;
  await deliverClaimedPoEmail(log, { readPdf: async () => pdf, sendMail: async () => { mockCalls++; throw Object.assign(new Error("mock failure"), { code: "EAUTH" }); } });
  const [failed] = await db.select().from(emailLogsTable).where(eq(emailLogsTable.id, log.id));
  assert.equal(failed.status, "failed");
  assert.ok(failed.lastError);
  assert.equal((await db.select().from(purchaseOrdersTable).where(eq(purchaseOrdersTable.id, po.id)))[0].status, "approved");
  const replay = await sendPoPreview(dealerId, actor.id, po.id, { snapshotId, to: "supplier@example.invalid", cc: "", subject: "Final subject", html: "<p>Final HTML</p>", resend: false });
  assert.equal(replay.id, log.id, "Duplicate confirm returns same log without a second send");
  const [claimed] = await db.update(emailLogsTable).set({ status: "sending" }).where(eq(emailLogsTable.id, log.id)).returning();
  await deliverClaimedPoEmail(claimed, { readPdf: async () => pdf, sendMail: async message => { mockCalls++; assert.equal(message.html, "<p>Final HTML</p>"); assert.deepEqual(message.attachments[0].content, pdf); return { messageId: `mock-${token}` }; } });
  const [sent] = await db.select().from(emailLogsTable).where(eq(emailLogsTable.id, log.id));
  assert.equal(sent.status, "sent"); assert.equal(sent.providerMessageId, `mock-${token}`); assert.equal(mockCalls, 2);
  assert.equal((await db.select().from(purchaseOrdersTable).where(eq(purchaseOrdersTable.id, po.id)))[0].status, "sent");
  const stale = await db.execute(sql`insert into po_email_snapshots(dealer_id,location_id,purchase_order_id,created_by,object_path,sha256,filename,to_address,cc,subject,body_html,po_fingerprint) values(${dealerId},${location.id},${po.id},${actor.id},'/objects/test-stale',${createHash("sha256").update(pdf).digest("hex")},'test.pdf','supplier@example.invalid','','Stale','Stale','stale') returning id`);
  await assert.rejects(() => sendPoPreview(dealerId!, actor.id, po.id, { snapshotId: Number(stale.rows[0].id), to: "supplier@example.invalid", cc: "", subject: "Stale", html: "Stale", resend: true }), /changed since preview/);
  await assert.rejects(() => sendPoPreview(dealerId! + 1000000, actor.id, po.id, { snapshotId, to: "supplier@example.invalid", cc: "", subject: "No", html: "No", resend: true }), /not found/);
  await db.transaction(async tx => {
    await tx.execute(sql`insert into po_communication_settings(dealer_id,location_id,sms_enabled,parts_manager,service_manager) values(${dealerId},${location.id},true,false,false)`);
    const event = { dealerId: dealerId!, purchaseOrderId: po.id, actorId: actor.id, receiptId: 999999, received: [{ lineId: line.id, quantity: 1 }] };
    await queuePoArrivalAlerts(tx, event); await queuePoArrivalAlerts(tx, event);
    const alerts = await tx.select().from(partNotificationDeliveriesTable).where(eq(partNotificationDeliveriesTable.dealerId, dealerId!));
    assert.equal(alerts.length, 2, "One internal and one SMS per recipient, replay deduped");
    assert.ok(alerts.every(a => a.payload.locationId === location.id && String(a.payload.body).includes(part.name)));
    await tx.update(purchaseOrderLinesTable).set({ isSpecialOrder: false }).where(eq(purchaseOrderLinesTable.id, line.id));
    await queuePoArrivalAlerts(tx, { ...event, receiptId: 1000000 });
    assert.equal((await tx.select().from(partNotificationDeliveriesTable).where(eq(partNotificationDeliveriesTable.dealerId, dealerId!))).length, 2, "Non-special receipts enqueue nothing");
  });
  console.log("PASS: provider failure remains approved; exact payload/PDF + provider ID; duplicate send; dealer isolation; arrival channels/replay dedupe; non-special silence; per-branch PO number.");
} finally {
  if (dealerId) {
    // Only the just-created, UUID-named isolated dealer is eligible for cleanup.
    const safe = await pool.query("select id from dealers where id=$1 and name=$2", [dealerId, `PO verification ${token}`]);
    if (safe.rowCount) {
      await pool.query("delete from po_email_snapshots where dealer_id=$1", [dealerId]);
      await pool.query("delete from email_logs where dealer_id=$1", [dealerId]);
      await pool.query("delete from part_notification_deliveries where dealer_id=$1", [dealerId]);
      await pool.query("delete from audit_logs where dealer_id=$1", [dealerId]);
      await pool.query("delete from purchase_order_lines where dealer_id=$1", [dealerId]);
      await pool.query("delete from purchase_orders where dealer_id=$1", [dealerId]);
      await pool.query("delete from po_communication_settings where dealer_id=$1", [dealerId]);
      await pool.query("delete from po_branch_counters where dealer_id=$1", [dealerId]);
      await pool.query("delete from parts where dealer_id=$1", [dealerId]);
      await pool.query("delete from suppliers where dealer_id=$1", [dealerId]);
      await pool.query("delete from inventory_locations where dealer_id=$1", [dealerId]);
      await pool.query("delete from dealer_users where dealer_id=$1", [dealerId]);
      await pool.query("delete from dealers where id=$1", [dealerId]);
    }
  }
  if (actorId) await pool.query("delete from users where id=$1 and clerk_id=$2", [actorId, `po-test-${token}`]);
  await pool.end();
}