/**
 * Synthetic requisition-to-procurement acceptance verifier.
 *
 * It targets the development API's test-persona middleware only. It creates
 * its own dealer-scoped rows and always removes them. No notification/email
 * endpoint is invoked; ERP queue rows created by PO enqueue calls are removed
 * during cleanup. Run with:
 *   AURA_ALLOW_SYNTHETIC_VERIFY=true pnpm --filter @workspace/scripts verify-part-requisitions
 */
import { pool } from "@workspace/db";

const BASE = process.env.API_BASE ?? "http://localhost:80/api";
const TECH = "procurement-verify-tech@aura-test.local";
const MANAGER = "procurement-verify-manager@aura-test.local";
const FOREIGN = "procurement-verify-foreign@aura-test.local";
const prefix = `PROC-VERIFY-${Date.now()}`;
let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = "") {
  if (ok) passed++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

async function api(method: string, path: string, user: string, dealerId: number, body?: unknown) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "x-test-user-email": user,
      "x-dealer-id": String(dealerId),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => null) as any };
}

async function seedUser(email: string, roleName: string, dealerId: number) {
  const role = await pool.query(`select id from roles where name=$1 limit 1`, [roleName]);
  if (!role.rows[0]) throw new Error(`Missing fixture role ${roleName}`);
  await pool.query(`delete from dealer_users where user_id in (select id from users where email=$1)`, [email]);
  await pool.query(`delete from users where email=$1`, [email]);
  const user = await pool.query(
    `insert into users(clerk_id,email,name,status) values($1,$2,$3,'active') returning id`,
    [`${prefix}-${email}`, email, `${roleName} Procurement Verifier`],
  );
  await pool.query(`insert into dealer_users(dealer_id,user_id,role_id) values($1,$2,$3)`,
    [dealerId, user.rows[0].id, role.rows[0].id]);
  return user.rows[0].id as number;
}

async function main() {
  if (process.env.NODE_ENV === "production" || process.env.AURA_ALLOW_SYNTHETIC_VERIFY !== "true") {
    throw new Error("Refusing synthetic verifier: set AURA_ALLOW_SYNTHETIC_VERIFY=true in a non-production environment");
  }
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(?::\d+)?\//.test(BASE)) {
    throw new Error(`Refusing non-local API target: ${BASE}`);
  }
  await pool.query(`select pg_advisory_lock(hashtext('aura-verify-requisition-procurement-v2'))`);
  const ids = {
    orders: [] as number[], cards: [] as number[], parts: [] as number[],
    requisitions: [] as number[], pos: [] as number[], suppliers: [] as number[],
  };
  try {
    const dealers = await pool.query(`select id from dealers order by id limit 2`);
    if ((dealers.rowCount ?? 0) < 2) throw new Error("Verifier needs two existing dealerships");
    const dealerId = Number(dealers.rows[0].id);
    const foreignDealerId = Number(dealers.rows[1].id);
    const techId = await seedUser(TECH, "Technician", dealerId);
    await seedUser(MANAGER, "Service Manager", dealerId);
    await seedUser(FOREIGN, "Service Manager", foreignDealerId);

    const serviceOrder = await pool.query(
      `insert into service_orders(dealer_id,vehicle_info,type,scheduled_date,technician_user_id)
       values($1,$2,'repair',current_date,$3) returning id`, [dealerId, `${prefix} vehicle`, techId]);
    const orderId = Number(serviceOrder.rows[0].id); ids.orders.push(orderId);
    const card = await pool.query(
      `insert into job_cards(dealer_id,service_order_id,title,status,technician_user_id,quote_approved_at,service_analysis,work_performed)
       values($1,$2,$3,'completed',$4,now(),'Verifier','Verifier') returning id`,
      [dealerId, orderId, `${prefix} card`, techId]);
    const cardId = Number(card.rows[0].id); ids.cards.push(cardId);
    const part = await pool.query(
      `insert into parts(dealer_id,sku,name,stock,unit_cost,unit_price)
       values($1,$2,$3,0,100,175) returning id`, [dealerId, `${prefix}-INT`, `${prefix} internal`]);
    const partId = Number(part.rows[0].id); ids.parts.push(partId);
    const suppliers = await pool.query(
      `insert into suppliers(dealer_id,name,status) values($1,$2,'active'),($1,$3,'active') returning id`,
      [dealerId, `${prefix} supplier A`, `${prefix} supplier B`]);
    const supplierA = Number(suppliers.rows[0].id), supplierB = Number(suppliers.rows[1].id);
    ids.suppliers.push(supplierA, supplierB);

    const created = await api("POST", `/job-cards/${cardId}/part-requisitions`, TECH, dealerId, {
      serviceOrderId: orderId, urgency: "vehicle_down", lines: [
        { source: "INTERNAL", partId, quantity: 3 },
        { source: "EXTERNAL", description: `${prefix} direct item`, supplier: `${prefix} supplier B`,
          quantity: 2, unitCost: 400, unitPrice: 650, taxCost: 20, freightCost: 30 },
      ],
    });
    const requisitionId = Number(created.json?.id); ids.requisitions.push(requisitionId);
    check("assigned technician creates requisition", created.status === 201);
    const approved = await api("POST", `/part-requisitions/${requisitionId}/decision`, MANAGER, dealerId,
      { action: "approve", reason: "required" });
    check("manager approves requisition", approved.status === 200 && approved.json?.status === "approved");
    const internalLine = Number(approved.json?.lines?.find((line: any) => line.source === "INTERNAL")?.id);
    const externalLine = Number(approved.json?.lines?.find((line: any) => line.source === "EXTERNAL")?.id);

    const partialBody = { idempotencyKey: `${prefix}-partial`, lines: [{ lineId: internalLine, supplierId: supplierA, quantity: 2 }] };
    const partial = await api("POST", `/part-requisitions/${requisitionId}/convert-to-purchase-orders`, MANAGER, dealerId, partialBody);
    if (partial.status !== 201) {
      throw new Error(`Partial conversion failed (${partial.status}): ${JSON.stringify(partial.json)}`);
    }
    const partialPo = Number(partial.json?.purchaseOrders?.[0]?.id);
    if (Number.isInteger(partialPo) && partialPo > 0) ids.pos.push(partialPo);
    check("partial conversion creates ordered PO and partially_ordered state",
      partial.status === 201 && partial.json?.requisition?.status === "partially_ordered" && partialPo > 0);
    const replay = await api("POST", `/part-requisitions/${requisitionId}/convert-to-purchase-orders`, MANAGER, dealerId, partialBody);
    check("conversion retry replays stable PO", replay.status === 200 && Number(replay.json?.purchaseOrders?.[0]?.id) === partialPo);
    const tooMuch = await api("POST", `/part-requisitions/${requisitionId}/convert-to-purchase-orders`, MANAGER, dealerId,
      { idempotencyKey: `${prefix}-over`, lines: [{ lineId: internalLine, supplierId: supplierA, quantity: 2 }] });
    check("over-allocation is refused", tooMuch.status === 422);

    const full = await api("POST", `/part-requisitions/${requisitionId}/convert-to-purchase-orders`, MANAGER, dealerId, {
      idempotencyKey: `${prefix}-full`, lines: [
        { lineId: internalLine, supplierId: supplierA, quantity: 1 },
        { lineId: externalLine, supplierId: supplierB, quantity: 2 },
      ],
    });
    if (full.status !== 201) {
      throw new Error(`Full conversion failed (${full.status}): ${JSON.stringify(full.json)}`);
    }
    const fullPos = (full.json?.purchaseOrders ?? [])
      .map((po: any) => Number(po.id))
      .filter((id: number) => Number.isInteger(id) && id > 0);
    ids.pos.push(...fullPos);
    check("full conversion reaches ordered and groups suppliers",
      full.status === 201 && full.json?.requisition?.status === "ordered" && fullPos.length === 2);
    const links = await pool.query(
      `select a.quantity_ordered,a.quantity_received,p.supplier_id,l.source
       from part_requisition_po_allocations a join purchase_orders p on p.id=a.purchase_order_id
       join purchase_order_lines l on l.id=a.purchase_order_line_id where a.dealer_id=$1 and a.requisition_id=$2`,
      [dealerId, requisitionId]);
    check("real PO allocation links retain source/supplier/quantities",
      links.rowCount === 3 && links.rows.reduce((n, r) => n + Number(r.quantity_ordered), 0) === 5 &&
      links.rows.some(r => r.source === "EXTERNAL" && Number(r.supplier_id) === supplierB));
    const foreignRead = await api("GET", `/part-requisitions/${requisitionId}`, FOREIGN, foreignDealerId);
    check("tenant isolation hides requisition", foreignRead.status === 404);

    const poList = await api("GET", "/purchase-orders", MANAGER, dealerId);
    const partialDetail = (poList.json ?? []).find((po: any) => Number(po.id) === partialPo);
    const firstInternalPoLine = Number(partialDetail?.lines?.[0]?.id);
    const receiveBody = { idempotencyKey: `${prefix}-receive-1`, lines: [{ lineId: firstInternalPoLine, qty: 1 }] };
    const received = await api("POST", `/purchase-orders/${partialPo}/receive`, MANAGER, dealerId, receiveBody);
    check("partial internal receipt accepted", received.status === 200 && received.json?.status === "partially_received");
    const duplicateReceipt = await api("POST", `/purchase-orders/${partialPo}/receive`, MANAGER, dealerId, receiveBody);
    const stockAfterDuplicate = await pool.query(`select stock from parts where id=$1 and dealer_id=$2`, [partId, dealerId]);
    check("duplicate receipt is idempotent", duplicateReceipt.status === 200 && Number(stockAfterDuplicate.rows[0].stock) === 1);
    const issueOne = await api("POST", `/part-requisitions/${requisitionId}/fulfill`, MANAGER, dealerId,
      { idempotencyKey: `${prefix}-issue-1`, lines: [{ lineId: internalLine, quantity: 1 }] });
    const stockAfterIssue = await pool.query(`select stock from parts where id=$1 and dealer_id=$2`, [partId, dealerId]);
    check("received internal stock is issued to job only after receipt", issueOne.status === 200 && Number(stockAfterIssue.rows[0].stock) === 0);

    const internalRemainingPo = full.json.purchaseOrders.find((po: any) => po.lines.some((l: any) => l.source === "INTERNAL"));
    const externalPo = full.json.purchaseOrders.find((po: any) => po.lines.some((l: any) => l.source === "EXTERNAL"));
    const internalRemainingLine = Number(internalRemainingPo.lines[0].id);
    const externalPoLine = Number(externalPo.lines[0].id);
    await api("POST", `/purchase-orders/${partialPo}/receive`, MANAGER, dealerId,
      { idempotencyKey: `${prefix}-receive-rest`, lines: [{ lineId: firstInternalPoLine, qty: 1 }] });
    await api("POST", `/purchase-orders/${internalRemainingPo.id}/receive`, MANAGER, dealerId,
      { idempotencyKey: `${prefix}-receive-2`, lines: [{ lineId: internalRemainingLine, qty: 1 }] });
    const issueRest = await api("POST", `/part-requisitions/${requisitionId}/fulfill`, MANAGER, dealerId,
      { idempotencyKey: `${prefix}-issue-2`, lines: [{ lineId: internalLine, quantity: 2 }] });
    check("remaining internal receipt can be coherently issued", issueRest.status === 200);
    const beforeExternal = await pool.query(`select stock from parts where id=$1`, [partId]);
    const externalReceived = await api("POST", `/purchase-orders/${externalPo.id}/receive`, MANAGER, dealerId,
      { idempotencyKey: `${prefix}-external`, lines: [{ lineId: externalPoLine, qty: 2 }] });
    const afterExternal = await pool.query(
      `select p.stock, count(e.id)::int as external_count, coalesce(sum(e.quantity),0)::int as external_qty
       from parts p left join external_job_card_parts e on e.dealer_id=p.dealer_id and e.job_card_id=$2
       where p.id=$1 group by p.stock`, [partId, cardId]);
    check("external receipt does not mutate stock and attaches once",
      externalReceived.status === 200 && Number(beforeExternal.rows[0].stock) === Number(afterExternal.rows[0].stock) &&
      afterExternal.rows[0].external_count === 1 && Number(afterExternal.rows[0].external_qty) === 2);
    const invoice = await api("POST", `/job-cards/${cardId}/invoice`, MANAGER, dealerId);
    check("external charge is invoiced exactly once", invoice.status === 201 &&
      Number(invoice.json?.externalPartsTotal) === 1300 && Number(invoice.json?.partsTotal) === 1825);

    const cancellable = await api("POST", `/job-cards/${cardId}/part-requisitions`, TECH, dealerId,
      { serviceOrderId: orderId, urgency: "routine", lines: [{ source: "INTERNAL", partId, quantity: 1 }] });
    const submittedCancelId = Number(cancellable.json?.id); ids.requisitions.push(submittedCancelId);
    const requesterCancel = await api("POST", `/part-requisitions/${submittedCancelId}/cancel`, TECH, dealerId, { reason: "no longer needed" });
    check("requester may cancel before approval", requesterCancel.status === 200 && requesterCancel.json?.status === "cancelled");
    const managerCancellable = await api("POST", `/job-cards/${cardId}/part-requisitions`, TECH, dealerId,
      { serviceOrderId: orderId, urgency: "routine", lines: [{ source: "INTERNAL", partId, quantity: 1 }] });
    const approvedCancelId = Number(managerCancellable.json?.id); ids.requisitions.push(approvedCancelId);
    await api("POST", `/part-requisitions/${approvedCancelId}/decision`, MANAGER, dealerId, { action: "approve", reason: "not needed" });
    const managerCancel = await api("POST", `/part-requisitions/${approvedCancelId}/cancel`, MANAGER, dealerId, { reason: "work declined" });
    check("manager may cancel approved unlinked requisition", managerCancel.status === 200 && managerCancel.json?.status === "cancelled");
    const conflictCancel = await api("POST", `/part-requisitions/${requisitionId}/cancel`, MANAGER, dealerId, { reason: "too late" });
    check("linked received procurement conflicts with cancellation", conflictCancel.status === 409);

    if (failures.length) throw new Error(`${failures.length} failure(s):\n${failures.join("\n")}`);
    console.log(`PASS ${passed} requisition procurement checks`);
  } finally {
    if (ids.cards.length) {
      await pool.query(`delete from service_invoices where job_card_id = any($1::int[])`, [ids.cards]);
      await pool.query(`delete from external_job_card_parts where job_card_id = any($1::int[])`, [ids.cards]);
    }
    // Delete allocations through their requisition before deleting generated POs.
    if (ids.requisitions.length) await pool.query(`delete from part_requisitions where id = any($1::int[])`, [ids.requisitions]);
    if (ids.pos.length) {
      await pool.query(`delete from erpnext_sync_jobs where entity_type='purchase_order' and entity_id = any($1::int[])`, [ids.pos]);
      await pool.query(`delete from purchase_orders where id = any($1::int[])`, [ids.pos]);
    }
    if (ids.cards.length) {
      await pool.query(`delete from job_card_parts where job_card_id = any($1::int[])`, [ids.cards]);
      await pool.query(`delete from job_cards where id = any($1::int[])`, [ids.cards]);
    }
    if (ids.orders.length) await pool.query(`delete from service_orders where id = any($1::int[])`, [ids.orders]);
    if (ids.parts.length) await pool.query(`delete from parts where id = any($1::int[])`, [ids.parts]);
    if (ids.suppliers.length) await pool.query(`delete from suppliers where id = any($1::int[])`, [ids.suppliers]);
    await pool.query(`delete from dealer_users where user_id in (select id from users where email = any($1::text[]))`, [[TECH, MANAGER, FOREIGN]]);
    await pool.query(`delete from users where email = any($1::text[])`, [[TECH, MANAGER, FOREIGN]]);
    await pool.query(`select pg_advisory_unlock(hashtext('aura-verify-requisition-procurement-v2'))`);
    await pool.end();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });