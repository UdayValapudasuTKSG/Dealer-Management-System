/**
 * Focused parts-requisition regression suite.
 * Requires the managed API workflow; it never sends email.
 */
import { pool } from "@workspace/db";

const BASE = "http://localhost:80/api";
const TECH = "part-req-tech@aura-test.local";
const MANAGER = "part-req-manager@aura-test.local";
const FOREIGN_MANAGER = "part-req-foreign-manager@aura-test.local";
let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = "") {
  if (ok) passed++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

async function api(
  method: string,
  path: string,
  user: string,
  dealerId: number,
  body?: unknown,
) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "x-test-user-email": user,
      "x-dealer-id": String(dealerId),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    json: (await response.json().catch(() => null)) as any,
  };
}

async function seedUser(email: string, roleName: string, dealerId: number) {
  await pool.query(`delete from dealer_users where user_id in (select id from users where email=$1)`, [email]);
  await pool.query(`delete from users where email=$1`, [email]);
  const role = await pool.query(`select id from roles where name=$1 limit 1`, [roleName]);
  if (!role.rows[0]) throw new Error(`Missing fixture role ${roleName}`);
  const user = await pool.query(
    `insert into users(clerk_id,email,name,status) values($1,$2,$3,'active') returning id`,
    [`part-req-${Date.now()}-${roleName}`, email, `${roleName} Requisition Fixture`],
  );
  await pool.query(
    `insert into dealer_users(dealer_id,user_id,role_id) values($1,$2,$3)`,
    [dealerId, user.rows[0].id, role.rows[0].id],
  );
  return user.rows[0].id as number;
}

async function main() {
  await pool.query(`select pg_advisory_lock(hashtext('aura-verify-part-requisitions-v1'))`);
  const ids = { orders: [] as number[], cards: [] as number[], parts: [] as number[] };
  try {
    const dealers = await pool.query(`select id from dealers order by id limit 2`);
    if (dealers.rowCount! < 2) throw new Error("Verifier needs two existing dealerships");
    const dealerId = dealers.rows[0].id as number;
    const foreignDealerId = dealers.rows[1].id as number;
    const techId = await seedUser(TECH, "Technician", dealerId);
    await seedUser(MANAGER, "Service Manager", dealerId);
    await seedUser(FOREIGN_MANAGER, "Service Manager", foreignDealerId);

    const order = await pool.query(
      `insert into service_orders(dealer_id,vehicle_info,type,scheduled_date,technician_user_id)
       values($1,'Requisition Verifier Vehicle','repair',current_date,$2) returning id`,
      [dealerId, techId],
    );
    const orderId = order.rows[0].id as number;
    ids.orders.push(orderId);
    const card = await pool.query(
      `insert into job_cards(dealer_id,service_order_id,title,status,technician_user_id,
          quote_approved_at,service_analysis,work_performed)
       values($1,$2,'Verifier work package','completed',$3,now(),'Verified','Verified') returning id`,
      [dealerId, orderId, techId],
    );
    const cardId = card.rows[0].id as number;
    ids.cards.push(cardId);
    const part = await pool.query(
      `insert into parts(dealer_id,sku,name,stock,unit_cost,unit_price)
       values($1,$2,'Verifier internal part',1,100,175) returning id`,
      [dealerId, `REQ-VERIFY-${Date.now()}`],
    );
    const partId = part.rows[0].id as number;
    ids.parts.push(partId);

    const created = await api("POST", `/job-cards/${cardId}/part-requisitions`, TECH, dealerId, {
      serviceOrderId: orderId,
      urgency: "vehicle_down",
      notes: "Focused verifier",
      lines: [
        { source: "INTERNAL", partId, quantity: 2 },
        {
          source: "EXTERNAL",
          description: "Imported verifier seal",
          supplier: "Verifier Supplier",
          quantity: 1,
          unitCost: 400,
          unitPrice: 650,
          taxCost: 20,
          freightCost: 30,
        },
      ],
    });
    const requisitionId = created.json?.id as number;
    check("assigned technician creates submitted requisition", created.status === 201 && created.json?.status === "submitted");

    const isolated = await api("GET", `/part-requisitions/${requisitionId}`, FOREIGN_MANAGER, foreignDealerId);
    check("tenant isolation hides foreign requisition", isolated.status === 404);

    const badOrder = await api("POST", `/part-requisitions/${requisitionId}/ordered`, MANAGER, dealerId, {});
    check("submitted cannot transition directly to ordered", badOrder.status === 422);
    const approved = await api("POST", `/part-requisitions/${requisitionId}/decision`, MANAGER, dealerId, {
      action: "approve",
      reason: "Required",
    });
    check("submitted transitions to approved", approved.status === 200 && approved.json?.status === "approved");
    const ordered = await api("POST", `/part-requisitions/${requisitionId}/ordered`, MANAGER, dealerId, {
      reference: "PO-VERIFY",
    });
    check("approved transitions to ordered", ordered.status === 200 && ordered.json?.status === "ordered");

    const lineIds = new Map<string, number>(
      (ordered.json?.lines ?? []).map((line: { source: string; id: number }) => [line.source, line.id]),
    );
    const insufficient = await api("POST", `/part-requisitions/${requisitionId}/fulfill`, MANAGER, dealerId, {
      idempotencyKey: "verify-insufficient",
      lines: [
        { lineId: lineIds.get("INTERNAL"), quantity: 2 },
        { lineId: lineIds.get("EXTERNAL"), quantity: 1 },
      ],
    });
    check("insufficient internal stock refuses whole fulfillment", insufficient.status === 409);
    const afterRefusal = await pool.query(
      `select stock,
        (select count(*)::int from external_job_card_parts where dealer_id=$1 and job_card_id=$2) external_count
       from parts where id=$3`,
      [dealerId, cardId, partId],
    );
    check("refusal rolls back inventory and external line", afterRefusal.rows[0].stock === 1 && afterRefusal.rows[0].external_count === 0);

    await pool.query(`update parts set stock=2 where id=$1 and dealer_id=$2`, [partId, dealerId]);
    const fulfilled = await api("POST", `/part-requisitions/${requisitionId}/fulfill`, MANAGER, dealerId, {
      idempotencyKey: "verify-success-0001",
      lines: [
        { lineId: lineIds.get("INTERNAL"), quantity: 2 },
        { lineId: lineIds.get("EXTERNAL"), quantity: 1 },
      ],
    });
    check("ordered requisition fulfills", fulfilled.status === 200 && fulfilled.json?.status === "fulfilled");
    const stock = await pool.query(`select stock from parts where id=$1`, [partId]);
    check("internal fulfillment decrements exact inventory", stock.rows[0].stock === 0);
    const external = await pool.query(
      `select count(*)::int count from external_job_card_parts where dealer_id=$1 and job_card_id=$2`,
      [dealerId, cardId],
    );
    check("external fulfillment creates one billable line without stock mutation", external.rows[0].count === 1);

    const retry = await api("POST", `/part-requisitions/${requisitionId}/fulfill`, MANAGER, dealerId, {
      idempotencyKey: "verify-success-0001",
      lines: [
        { lineId: lineIds.get("INTERNAL"), quantity: 2 },
        { lineId: lineIds.get("EXTERNAL"), quantity: 1 },
      ],
    });
    check("fulfillment retry is idempotent", retry.status === 200 && retry.json?.status === "fulfilled");
    const invoice = await api("POST", `/job-cards/${cardId}/invoice`, MANAGER, dealerId);
    check(
      "invoice includes internal and external customer charges exactly once",
      invoice.status === 201 &&
        invoice.json?.partsTotal === 1000 &&
        invoice.json?.externalPartsTotal === 650,
      JSON.stringify(invoice.json),
    );

    if (failures.length) throw new Error(`${failures.length} failure(s):\n${failures.join("\n")}`);
    console.log(`PASS ${passed} focused requisition checks`);
  } finally {
    await pool.query(`delete from service_invoices where job_card_id = any($1::int[])`, [ids.cards]);
    await pool.query(`delete from external_job_card_parts where job_card_id = any($1::int[])`, [ids.cards]);
    await pool.query(`delete from part_requisitions where job_card_id = any($1::int[])`, [ids.cards]);
    await pool.query(`delete from job_card_parts where job_card_id = any($1::int[])`, [ids.cards]);
    await pool.query(`delete from job_cards where id = any($1::int[])`, [ids.cards]);
    await pool.query(`delete from service_orders where id = any($1::int[])`, [ids.orders]);
    await pool.query(`delete from parts where id = any($1::int[])`, [ids.parts]);
    await pool.query(`delete from dealer_users where user_id in (select id from users where email = any($1::text[]))`, [[TECH, MANAGER, FOREIGN_MANAGER]]);
    await pool.query(`delete from users where email = any($1::text[])`, [[TECH, MANAGER, FOREIGN_MANAGER]]);
    await pool.query(`select pg_advisory_unlock(hashtext('aura-verify-part-requisitions-v1'))`);
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});