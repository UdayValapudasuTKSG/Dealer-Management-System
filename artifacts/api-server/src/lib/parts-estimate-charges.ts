import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
type Executor = Pick<typeof db, "execute">;

export async function loadPartsEstimateCharges(tx: Executor, dealerId: number, jobCardId: number) {
  const result = await tx.execute(sql`SELECT shipping_amount, duties_amount FROM parts_estimate_charges
    WHERE dealer_id = ${dealerId} AND job_card_id = ${jobCardId}`);
  const row = result.rows[0];
  return { shippingTotal: Number(row?.shipping_amount ?? 0), dutiesTotal: Number(row?.duties_amount ?? 0) };
}

export async function snapshotServicePartsCharges(
  tx: Executor, dealerId: number, invoiceId: number,
  charges: { shippingTotal: number; dutiesTotal: number },
) {
  await tx.execute(sql`INSERT INTO service_invoice_parts_charges
    (dealer_id, invoice_id, shipping_amount, duties_amount)
    VALUES (${dealerId}, ${invoiceId}, ${charges.shippingTotal.toFixed(2)}, ${charges.dutiesTotal.toFixed(2)})`);
}

export async function loadServiceInvoicePartsCharges(dealerId: number, invoiceId: number) {
  const result = await db.execute(sql`SELECT shipping_amount, duties_amount FROM service_invoice_parts_charges
    WHERE dealer_id = ${dealerId} AND invoice_id = ${invoiceId}`);
  return { shippingTotal: Number(result.rows[0]?.shipping_amount ?? 0), dutiesTotal: Number(result.rows[0]?.duties_amount ?? 0) };
}