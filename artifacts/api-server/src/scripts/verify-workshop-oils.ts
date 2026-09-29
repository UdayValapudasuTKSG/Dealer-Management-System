/**
 * Development-only, rollback-only fixture. No customer data, emails or
 * production stock is touched. Run with NODE_ENV=development and
 * OUTBOX_WORKER_DISABLED=1 after the tracked migration is applied.
 */
import { strict as assert } from "node:assert";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { oilCharges, snapshotInvoiceOils } from "../lib/workshop-oils";

if (process.env.NODE_ENV !== "development" || process.env.OUTBOX_WORKER_DISABLED !== "1" ||
    process.env.EXTERNAL_DATABASE_URL) {
  throw new Error("Run only against isolated development DB with OUTBOX_WORKER_DISABLED=1");
}
const rollback = new Error("verified-rollback");
try {
  await db.transaction(async tx => {
    // Negative synthetic dealer ids are deliberately outside ordinary tenant IDs.
    const dealer = -2147483000;
    const order = await tx.execute(sql`INSERT INTO service_orders
      (dealer_id,vehicle_info,scheduled_date) VALUES (${dealer},'OIL-TEST-FIXTURE',CURRENT_DATE) RETURNING id`);
    const orderId = Number(order.rows[0]!.id);
    const card = await tx.execute(sql`INSERT INTO job_cards
      (dealer_id,service_order_id,title) VALUES (${dealer},${orderId},'OIL-TEST-FIXTURE') RETURNING id`);
    const jobId = Number(card.rows[0]!.id);
    const oil = await tx.execute(sql`INSERT INTO workshop_oils
      (dealer_id,name,stock_litres,purchase_cost_per_litre,selling_price_per_litre)
      VALUES (${dealer},'OIL-TEST-FIXTURE', '5.000', '700.00', '1234.56') RETURNING id`);
    const oilId = Number(oil.rows[0]!.id);
    const request = await tx.execute(sql`INSERT INTO workshop_oil_requests
      (dealer_id,job_card_id,oil_id,requested_litres,name_snapshot,unit_price_per_litre,requested_by)
      VALUES (${dealer},${jobId},${oilId},'4.500','OIL-TEST-FIXTURE','1234.56',1) RETURNING id`);
    const requestId = Number(request.rows[0]!.id);
    assert.deepEqual(await oilCharges(tx, dealer, jobId), [], "request alone is not billable");
    const approval = await tx.execute(sql`UPDATE workshop_oil_requests
      SET status='approved',approved_by=2,approved_at=now()
      WHERE dealer_id=${dealer} AND id=${requestId} AND status='requested' RETURNING status`);
    assert.equal(approval.rows[0]?.status, "approved");
    // Conditional update is an atomic stock backstop even if another issuer
    // took the last litres. A duplicate issue should have no remaining demand.
    const issue = await tx.execute(sql`UPDATE workshop_oils SET stock_litres=stock_litres-4.500
      WHERE dealer_id=${dealer} AND id=${oilId} AND stock_litres>=4.500 RETURNING stock_litres`);
    assert.equal(Number(issue.rows[0]!.stock_litres), 0.5);
    const insufficient = await tx.execute(sql`UPDATE workshop_oils SET stock_litres=stock_litres-1.000
      WHERE dealer_id=${dealer} AND id=${oilId} AND stock_litres>=1.000 RETURNING id`);
    assert.equal(insufficient.rows.length, 0, "insufficient stock cannot be issued");
    await tx.execute(sql`UPDATE workshop_oil_requests SET issued_litres='4.500',status='issued'
      WHERE dealer_id=${dealer} AND id=${requestId} AND status='approved' AND issued_litres='0'`);
    const duplicate = await tx.execute(sql`UPDATE workshop_oil_requests SET issued_litres='4.500'
      WHERE dealer_id=${dealer} AND id=${requestId} AND issued_litres='0' RETURNING id`);
    assert.equal(duplicate.rows.length, 0, "duplicate issue is not a second movement");
    const [charge] = await oilCharges(tx, dealer, jobId);
    assert.equal(charge?.litres, 4.5);
    assert.equal(charge?.amount, 5555.52, "4.5 L times snapshotted GYD per-litre price");
    assert.deepEqual(await oilCharges(tx, dealer - 1, jobId), [], "tenant isolation");
    const invoice = await tx.execute(sql`INSERT INTO service_invoices
      (dealer_id,service_order_id,job_card_id,vehicle_info,parts_total,total)
      VALUES (${dealer},${orderId},${jobId},'OIL-TEST-FIXTURE','5555.52','5555.52') RETURNING id`);
    const invoiceId = Number(invoice.rows[0]!.id);
    await snapshotInvoiceOils(tx, dealer, invoiceId, [charge!]);
    const billed = await tx.execute(sql`SELECT quantity_litres, amount FROM workshop_invoice_oils
      WHERE dealer_id=${dealer} AND invoice_id=${invoiceId}`);
    assert.equal(Number(billed.rows[0]!.quantity_litres), 4.5);
    assert.equal(Number(billed.rows[0]!.amount), 5555.52);
    const after = await tx.execute(sql`SELECT stock_litres FROM workshop_oils WHERE id=${oilId}`);
    assert.equal(Number(after.rows[0]!.stock_litres), 0.5, "invoice never deducts again");
    // Ordinary parts remain INTEGER columns, untouched by the oil migration.
    const ordinary = await tx.execute(sql`SELECT data_type FROM information_schema.columns
      WHERE table_name='parts' AND column_name='stock'`);
    assert.equal(ordinary.rows[0]?.data_type, "integer");
    throw rollback;
  });
} catch (e) {
  if (e !== rollback) throw e;
}
process.stdout.write("Oil fixture passed; transaction rolled back.\n");