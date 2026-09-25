import { pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import { allocate, flags } from "./supplier-invoice-money";
export class InvoiceError extends Error { constructor(message: string, public status = 409) { super(message); } }
export const requireInvoice = (condition: unknown, message: string, status = 409): asserts condition => { if (!condition) throw new InvoiceError(message, status); };
type Client = { query: typeof pool.query };
export async function invoiceTransaction<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try { await c.query("BEGIN"); const result = await fn(c); await c.query("COMMIT"); return result; }
  catch (error) { await c.query("ROLLBACK"); throw error; } finally { c.release(); }
}
export async function invoiceAudit(c: Client, dealer: number, actor: number, id: number, summary: string, details: unknown) {
  await c.query(`INSERT INTO audit_logs(dealer_id,actor_user_id,module,action,entity_type,entity_id,summary,details)
    VALUES($1,$2,'parts','update','supplier_invoice',$3,$4,$5)`, [dealer, actor, String(id), summary, JSON.stringify(details)]);
}
/** Core must call INSIDE its PO-close transaction; shared PO row lock prevents upload/close races. */
export async function assertNoUnreconciledSupplierInvoices(tx: { execute: (q: any) => Promise<any> }, dealerId: number, poId: number) {
  await tx.execute(sql`select id from purchase_orders where dealer_id=${dealerId} and id=${poId} for update`);
  const result = await tx.execute(sql`select id from supplier_invoices where dealer_id=${dealerId} and po_id=${poId} and status <> 'reconciled' limit 1`);
  if (result.rows.length) throw new InvoiceError("Reconcile all supplier invoices before closing this PO");
}
export async function lockedPo(c: Client, dealer: number, location: number, po: number) {
  const { rows } = await c.query(`SELECT p.* FROM purchase_orders p JOIN inventory_locations l ON l.id=p.location_id AND l.dealer_id=p.dealer_id
    JOIN suppliers s ON s.id=p.supplier_id AND s.dealer_id=p.dealer_id
    WHERE p.id=$1 AND p.dealer_id=$2 AND p.location_id=$3 AND l.active=true FOR UPDATE OF p`, [po, dealer, location]);
  if (!rows[0]) throw new InvoiceError("PO not found in selected dealer and branch", 404);
  return rows[0];
}
export async function poLines(c: Client, dealer: number, po: number) {
  return (await c.query(`SELECT l.*,p.sku AS part_number,
    coalesce((SELECT sum(il.quantity) FROM supplier_invoice_lines il JOIN supplier_invoices si ON si.id=il.invoice_id
      WHERE il.po_line_id=l.id AND si.dealer_id=l.dealer_id AND si.status='reconciled'),0)::integer AS invoiced_quantity
    FROM purchase_order_lines l
    LEFT JOIN parts p ON p.id=l.part_id AND p.dealer_id=l.dealer_id
    WHERE l.purchase_order_id=$1 AND l.dealer_id=$2 ORDER BY l.id`, [po, dealer])).rows;
}
export function lineFlags(line: any, poLine: any, bps: number) {
  if (!poLine) return ["unmatched"];
  return flags(line.quantity, Math.max(0,poLine.qty_received-(poLine.invoiced_quantity??0)), BigInt(line.unit_cost_minor),
    BigInt(Math.round(poLine.unit_cost * 100)), bps);
}
export function varianceSnapshot(line: any, poLine: any, bps: number) {
  return { quantity: line.quantity, received: poLine ? Math.max(0,poLine.qty_received-(poLine.invoiced_quantity??0)) : null, cost: String(line.unit_cost_minor), orderedCost: poLine?.unit_cost ?? null, bps };
}
export async function reconcileInvoice(dealer: number, location: number, actor: number, invoiceId: number) {
  return invoiceTransaction(async c => {
    const initial = (await c.query("SELECT po_id FROM supplier_invoices WHERE id=$1 AND dealer_id=$2 AND location_id=$3", [invoiceId, dealer, location])).rows[0];
    if (!initial) throw new InvoiceError("Invoice not found", 404);
    await lockedPo(c, dealer, location, initial.po_id);
    const invoice = (await c.query("SELECT * FROM supplier_invoices WHERE id=$1 FOR UPDATE", [invoiceId])).rows[0];
    if (invoice.status === "reconciled") return invoice;
    const lines = (await c.query("SELECT * FROM supplier_invoice_lines WHERE invoice_id=$1 ORDER BY id FOR UPDATE", [invoiceId])).rows;
    const ordered = await poLines(c, dealer, invoice.po_id);
    const allocations = allocate(BigInt(invoice.shipping_minor) + BigInt(invoice.duties_minor), lines.map(l => BigInt(l.quantity) * BigInt(l.unit_cost_minor)));
    // Lock parts in stable order, using the same lock as receiving/issuing.
    const partIds = [...new Set(ordered.filter(p => lines.some(l => l.po_line_id === p.id)).map(p => p.part_id))].sort((a,b) => a-b);
    for (const part of partIds) await c.query("SELECT id FROM parts WHERE id=$1 AND dealer_id=$2 FOR UPDATE", [part, dealer]);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i], poLine = ordered.find(p => p.id === line.po_line_id);
      if (!poLine?.part_id) throw new InvoiceError(`Map invoice line ${line.part_number} to a PO part before reconciliation`);
      const variances = lineFlags(line, poLine, invoice.tolerance_bps);
      if (variances.length && !line.accepted_reason) throw new InvoiceError(`Accept variances for ${line.part_number} with a reason first`);
      if (variances.length && Object.entries(varianceSnapshot(line,poLine,invoice.tolerance_bps)).some(([key,value])=>line.accepted_snapshot?.[key]!==value))
        throw new InvoiceError(`Receipt or pricing changed for ${line.part_number}; accept the current variance again`);
      if(line.quantity>poLine.qty_received-poLine.invoiced_quantity)
        throw new InvoiceError(`Invoice quantity for ${line.part_number} exceeds the received quantity not yet invoiced (${poLine.qty_received-poLine.invoiced_quantity}). Receive the outstanding goods first.`);
      const landed = BigInt(line.quantity) * BigInt(line.unit_cost_minor) + allocations[i];
      if (!poLine.qty_received && landed) throw new InvoiceError("Cannot cost an unreceived line");
      // A zero-quantity invoice line carries no inventory cost. It remains in
      // the reconciliation/audit, but must not zero out an existing receipt.
      if (line.quantity === 0) {
        await c.query("UPDATE supplier_invoice_lines SET allocated_minor=0,match_status=$1 WHERE id=$2",[JSON.stringify(variances),line.id]);
        continue;
      }
      const unitMinor = (landed + BigInt(line.quantity) / 2n) / BigInt(line.quantity);
      // Receipt layers already contain the inventory. Revalue ONLY their remaining quantities.
      const layers = (await c.query(`SELECT l.*,t.unit_cost_at_transaction AS receipt_unit_cost,
        coalesce((SELECT sum(a.quantity) FROM supplier_invoice_cost_allocations a WHERE a.layer_id=l.id),0)::integer AS invoiced_quantity
        FROM inventory_cost_layers l
        JOIN inventory_transactions t ON t.id=l.receipt_transaction_id AND t.dealer_id=l.dealer_id
        JOIN purchase_order_receipts r ON r.id::text=t.reference_id AND r.dealer_id=t.dealer_id
        WHERE l.dealer_id=$1 AND l.part_id=$2 AND l.location_id=$3
        AND t.reference_type='purchase_order_receipt' AND r.purchase_order_id=$4 ORDER BY l.created_at,l.id FOR UPDATE OF l`,
      [dealer, poLine.part_id, location, invoice.po_id])).rows;
      if (poLine.qty_received && !layers.length) throw new InvoiceError("Receipt cost layers are missing; repair receipt accounting before reconciliation");
      // Repeated part numbers on one PO are ambiguous for receipt-layer allocation.
      if (ordered.filter(p => p.part_id === poLine.part_id).length > 1) throw new InvoiceError("Repeated PO part requires consolidated lines before costing");
      let remaining=line.quantity;
      const assigned=layers.map(layer=>{
        const quantity=Math.min(remaining,layer.quantity_received-layer.invoiced_quantity);
        remaining-=quantity;
        const consumed=layer.quantity_received-layer.quantity_remaining;
        const retained=Math.max(0,layer.invoiced_quantity+quantity-Math.max(consumed,layer.invoiced_quantity));
        return {layer,quantity,retained};
      }).filter(a=>a.quantity>0);
      if(remaining)throw new InvoiceError("Received quantity has no un-invoiced cost layers; repair receipt accounting before reconciliation");
      const layerAmounts=allocate(landed,assigned.map(a=>BigInt(a.quantity)));
      for (let j=0;j<assigned.length;j++) {
        const {layer,quantity,retained}=assigned[j],layerAmount=layerAmounts[j];
        await c.query(`UPDATE inventory_levels SET average_unit_cost=CASE WHEN quantity_on_hand>0 THEN
          greatest(0,(average_unit_cost::numeric*quantity_on_hand + ($1::numeric/100/$8-$2::numeric)*$3)/quantity_on_hand) ELSE 0 END, updated_at=now()
          WHERE dealer_id=$4 AND part_id=$5 AND location_id=$6 AND bin_id IS NOT DISTINCT FROM $7`,
        [layerAmount.toString(), layer.receipt_unit_cost, retained, dealer, poLine.part_id, location, layer.bin_id,quantity]);
        await c.query(`UPDATE inventory_cost_layers SET unit_cost=CASE WHEN quantity_remaining>0 THEN
          greatest(0,unit_cost::numeric+($1::numeric/100/$3-$4::numeric)*$5/quantity_remaining) ELSE unit_cost END WHERE id=$2`,
          [layerAmount.toString(),layer.id,quantity,layer.receipt_unit_cost,retained]);
        await c.query(`INSERT INTO supplier_invoice_cost_allocations(invoice_line_id,layer_id,quantity,landed_minor,quantity_remaining_at_reconcile)
          VALUES($1,$2,$3,$4,$5)`,[line.id,layer.id,quantity,layerAmount.toString(),retained]);
      }
      await c.query(`UPDATE parts SET unit_cost=coalesce((SELECT sum(quantity_on_hand*average_unit_cost)/nullif(sum(quantity_on_hand),0)
        FROM inventory_levels WHERE dealer_id=$1 AND part_id=$2),$3::numeric/100),updated_at=now() WHERE dealer_id=$1 AND id=$2`, [dealer, poLine.part_id, unitMinor.toString()]);
      await c.query(`INSERT INTO supplier_invoice_part_costs(dealer_id,part_id,last_cost_minor,invoice_id) VALUES($1,$2,$3,$4)
        ON CONFLICT(dealer_id,part_id) DO UPDATE SET last_cost_minor=excluded.last_cost_minor,invoice_id=excluded.invoice_id,updated_at=now()`,
      [dealer, poLine.part_id, unitMinor.toString(), invoiceId]);
      await c.query("UPDATE supplier_invoice_lines SET allocated_minor=$1,match_status=$2 WHERE id=$3", [allocations[i].toString(), JSON.stringify(variances), line.id]);
    }
    const updated = (await c.query("UPDATE supplier_invoices SET status='reconciled',reconciled_by=$1,reconciled_at=now() WHERE id=$2 RETURNING *", [actor, invoiceId])).rows[0];
    await invoiceAudit(c, dealer, actor, invoiceId, "Supplier invoice reconciled", { before: "pending", after: "reconciled", allocations: allocations.map(String), stockChanged: false });
    return updated;
  });
}