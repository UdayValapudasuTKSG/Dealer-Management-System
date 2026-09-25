import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
if(process.env.NODE_ENV!=="development"||process.env.TEST_SUPPLIER_INVOICES_DB!=="yes")throw new Error("Development only: TEST_SUPPLIER_INVOICES_DB=yes required");
const {pool}=await import("@workspace/db");
const {reconcileInvoice,invoiceTransaction,lockedPo}=await import("../lib/supplier-invoices");
let dealer=0;
const q=async(text:string,args:any[]=[])=> (await pool.query(text,args)).rows;
try {
  dealer=(await q("INSERT INTO dealers(name) VALUES($1) RETURNING id",[`Invoice test ${randomUUID()}`]))[0].id;
  const location=(await q("INSERT INTO inventory_locations(dealer_id,name) VALUES($1,'Invoice test') RETURNING id",[dealer]))[0].id;
  const supplier=(await q("INSERT INTO suppliers(dealer_id,name) VALUES($1,'Invoice test') RETURNING id",[dealer]))[0].id;
  const part=(await q("INSERT INTO parts(dealer_id,sku,name,stock,unit_cost,inventory_initialized_at) VALUES($1,'TEST','Test part',3,1,now()) RETURNING id",[dealer]))[0].id;
  const po=(await q("INSERT INTO purchase_orders(dealer_id,supplier_id,location_id,status) VALUES($1,$2,$3,'received') RETURNING id",[dealer,supplier,location]))[0].id;
  const otherPo=(await q("INSERT INTO purchase_orders(dealer_id,supplier_id,location_id) VALUES($1,$2,$3) RETURNING id",[dealer,supplier,location]))[0].id;
  const line=(await q("INSERT INTO purchase_order_lines(dealer_id,purchase_order_id,part_id,part_name,quantity,qty_received,unit_cost) VALUES($1,$2,$3,'Test',3,3,1) RETURNING id",[dealer,po,part]))[0].id;
  const receipt=(await q(`INSERT INTO purchase_order_receipts(dealer_id,purchase_order_id,idempotency_key,request_fingerprint,received_at,received_by_name,delivery_note_number,warehouse_location,condition)
    VALUES($1,$2,'test','test',now(),'test','test','test','good') RETURNING id`,[dealer,po]))[0].id;
  const movement=(await q(`INSERT INTO inventory_transactions(dealer_id,part_id,location_id,type,quantity_delta,reference_type,reference_id,unit_cost_at_transaction,value_delta)
    VALUES($1,$2,$3,'receipt',3,'purchase_order_receipt',$4,1,3) RETURNING id`,[dealer,part,location,String(receipt)]))[0].id;
  await q("INSERT INTO inventory_cost_layers(dealer_id,part_id,location_id,receipt_transaction_id,quantity_received,quantity_remaining,unit_cost) VALUES($1,$2,$3,$4,3,3,1)",[dealer,part,location,movement]);
  await q("INSERT INTO inventory_levels(dealer_id,part_id,location_id,quantity_on_hand,average_unit_cost) VALUES($1,$2,$3,3,1)",[dealer,part,location]);
  const create=`INSERT INTO supplier_invoices(dealer_id,location_id,supplier_id,po_id,invoice_number,invoice_date,object_path,file_name,subtotal_minor,shipping_minor,duties_minor,tax_minor,total_minor,created_by)
    VALUES($1,$2,$3,$4,$5,current_date,'/test','test.pdf',100,1,0,0,101,1) RETURNING id`;
  const invoice=(await q(create,[dealer,location,supplier,po," TEST-123 "]))[0].id;
  await assert.rejects(q(create,[dealer,location,supplier,otherPo,"test-123"]),(e:any)=>e.code==="23505");
  await q("INSERT INTO supplier_invoice_lines(invoice_id,po_line_id,part_number,description,quantity,unit_cost_minor) VALUES($1,$2,'TEST','test',1,100)",[invoice,line]);
  await assert.rejects(invoiceTransaction(c=>lockedPo(c,dealer+1000000,location,po)),/not found/);
  await assert.rejects(reconcileInvoice(dealer,location+1000000,1,invoice),/not found/);
  await assert.rejects(reconcileInvoice(dealer,location,1,invoice),/Accept variances/);
  await q("UPDATE supplier_invoice_lines SET accepted_reason='Partial invoice',accepted_by=1,accepted_at=now(),accepted_snapshot=$1 WHERE invoice_id=$2",
    [JSON.stringify({quantity:1,received:3,cost:"100",orderedCost:1,bps:0}),invoice]);
  await Promise.all([reconcileInvoice(dealer,location,1,invoice),reconcileInvoice(dealer,location,1,invoice)]);
  await reconcileInvoice(dealer,location,1,invoice);
  const stock=(await q("SELECT stock,unit_cost FROM parts WHERE id=$1",[part]))[0];
  assert.equal(stock.stock,3);assert.ok(Math.abs(stock.unit_cost-3.01/3)<1e-9);
  assert.equal((await q("SELECT count(*)::int AS n FROM inventory_transactions WHERE dealer_id=$1",[dealer]))[0].n,1);
  assert.equal((await q("SELECT count(*)::int AS n FROM audit_logs WHERE dealer_id=$1 AND summary='Supplier invoice reconciled'",[dealer]))[0].n,1);
  const second=(await q(create,[dealer,location,supplier,po,"second-partial"]))[0].id;
  await q("UPDATE supplier_invoices SET subtotal_minor=400,shipping_minor=0,total_minor=400 WHERE id=$1",[second]);
  await q(`INSERT INTO supplier_invoice_lines(invoice_id,po_line_id,part_number,description,quantity,unit_cost_minor,accepted_reason,accepted_snapshot)
    VALUES($1,$2,'TEST','test',2,200,'Price accepted',$3)`,[second,line,JSON.stringify({quantity:2,received:2,cost:"200",orderedCost:1,bps:0})]);
  await Promise.all([reconcileInvoice(dealer,location,1,second),reconcileInvoice(dealer,location,1,second)]);
  const combined=(await q("SELECT stock,unit_cost FROM parts WHERE id=$1",[part]))[0];
  assert.equal(combined.stock,3);assert.ok(Math.abs(combined.unit_cost-5.01/3)<1e-9);
  assert.equal((await q("SELECT sum(quantity)::int AS n FROM supplier_invoice_cost_allocations WHERE layer_id IN(SELECT id FROM inventory_cost_layers WHERE dealer_id=$1)",[dealer]))[0].n,3);
  assert.equal((await q("SELECT count(*)::int AS n FROM audit_logs WHERE dealer_id=$1 AND summary='Supplier invoice reconciled'",[dealer]))[0].n,2);
  const excess=(await q(create,[dealer,location,supplier,po,"excess-invoice"]))[0].id;
  await q(`INSERT INTO supplier_invoice_lines(invoice_id,po_line_id,part_number,description,quantity,unit_cost_minor,accepted_reason,accepted_snapshot)
    VALUES($1,$2,'TEST','test',1,100,'Variance accepted',$3)`,[excess,line,JSON.stringify({quantity:1,received:0,cost:"100",orderedCost:1,bps:0})]);
  await assert.rejects(reconcileInvoice(dealer,location,1,excess),/exceeds the received quantity/);
  assert.equal((await q("SELECT count(*)::int AS n FROM inventory_transactions WHERE dealer_id=$1",[dealer]))[0].n,1);
  console.log("PASS duplicate normalization across POs, dealer/branch isolation, received-quantity variance, concurrent exactly-once partial invoice costing, penny allocation, unchanged stock and inventory ledger");
} finally {
  if(dealer) {
    await q("DELETE FROM supplier_invoice_cost_allocations WHERE invoice_line_id IN(SELECT l.id FROM supplier_invoice_lines l JOIN supplier_invoices i ON i.id=l.invoice_id WHERE i.dealer_id=$1)",[dealer]);
    await q("DELETE FROM supplier_invoice_lines WHERE invoice_id IN(SELECT id FROM supplier_invoices WHERE dealer_id=$1)",[dealer]);
    for(const table of ["supplier_invoice_part_costs","supplier_invoices","inventory_cost_layers","inventory_transactions","inventory_levels","purchase_order_receipt_lines","purchase_order_receipts","purchase_order_lines","purchase_orders","parts","suppliers","inventory_locations","audit_logs"])
      await q(`DELETE FROM ${table} WHERE dealer_id=$1`,[dealer]);
    await q("DELETE FROM dealers WHERE id=$1",[dealer]);
  }
  await pool.end();
}