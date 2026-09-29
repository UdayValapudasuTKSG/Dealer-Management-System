import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

type Executor = Pick<typeof db, "execute">;
export type OilCharge = { requestId: number; name: string; litres: number; price: number; amount: number };
export const money = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** The price is captured on request. Only physically issued, unreturned litres are billable. */
export async function oilCharges(tx: Executor, dealerId: number, jobId: number): Promise<OilCharge[]> {
  const rows = await tx.execute(sql`SELECT id, name_snapshot, issued_litres, returned_litres, unit_price_per_litre
    FROM workshop_oil_requests WHERE dealer_id=${dealerId} AND job_card_id=${jobId}
    AND issued_litres > returned_litres ORDER BY id`);
  return rows.rows.map(r => ({
    requestId: Number(r.id), name: String(r.name_snapshot),
    litres: Number(r.issued_litres) - Number(r.returned_litres),
    price: Number(r.unit_price_per_litre),
    amount: money((Number(r.issued_litres) - Number(r.returned_litres)) * Number(r.unit_price_per_litre)),
  }));
}

export async function snapshotInvoiceOils(tx: Executor, dealerId: number, invoiceId: number, charges: OilCharge[]) {
  for (const charge of charges) {
    await tx.execute(sql`INSERT INTO workshop_invoice_oils
      (dealer_id, invoice_id, request_id, name_snapshot, quantity_litres, unit_price_per_litre, amount)
      VALUES (${dealerId}, ${invoiceId}, ${charge.requestId}, ${charge.name},
        ${charge.litres.toFixed(3)}, ${charge.price.toFixed(2)}, ${charge.amount.toFixed(2)})`);
  }
}

export async function invoiceOilCharges(dealerId: number, invoiceId: number): Promise<OilCharge[]> {
  const rows = await db.execute(sql`SELECT request_id, name_snapshot, quantity_litres, unit_price_per_litre, amount
    FROM workshop_invoice_oils WHERE dealer_id=${dealerId} AND invoice_id=${invoiceId} ORDER BY id`);
  return rows.rows.map(r => ({ requestId: Number(r.request_id), name: String(r.name_snapshot),
    litres: Number(r.quantity_litres), price: Number(r.unit_price_per_litre), amount: Number(r.amount) }));
}