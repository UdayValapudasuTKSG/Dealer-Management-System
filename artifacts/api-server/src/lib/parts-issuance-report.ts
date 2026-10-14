import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export async function partsIssuanceReport(dealerId: number, from?: string, to?: string) {
  // Reference IDs are text: compare to text IDs, never cast unknown ledger
  // references to integers. Every joined business record is dealer scoped.
  const result = await db.execute(sql`
    select t.id, t.created_at as "issuedAt", p.sku, p.name as "part",
      -t.quantity_delta as quantity,
      case when j.id is not null then 'Workshop / job card'
           when i.id is not null then 'Customer'
           else 'Other / unrecorded' end as "issuedTo",
      coalesce(s.customer_name, i.customer_name, 'Not recorded') as customer,
      j.id as "jobCardId",
      coalesce(tech.name, j.technician_name, 'Not recorded') as technician,
      coalesce(actor.name, 'Not recorded') as "issuedBy",
      coalesce(l.name, 'Not recorded') as location,
      t.reference_type as "referenceType", t.reference_id as reference
    from inventory_transactions t
    join parts p on p.id=t.part_id and p.dealer_id=t.dealer_id
    left join job_card_parts jp on t.reference_type='job_card_part'
      and jp.id::text=t.reference_id and jp.dealer_id=t.dealer_id
    left join job_cards j on j.id=jp.job_card_id and j.dealer_id=t.dealer_id
    left join service_orders s on s.id=j.service_order_id and s.dealer_id=t.dealer_id
    left join invoices i on t.reference_type='parts_customer_invoice'
      and i.id::text=t.reference_id and i.dealer_id=t.dealer_id
    left join users tech on tech.id=j.technician_user_id
    left join users actor on actor.id=t.created_by
    left join inventory_locations l on l.id=t.location_id and l.dealer_id=t.dealer_id
    where t.dealer_id=${dealerId} and t.type='issue' and t.quantity_delta<0
      ${from ? sql`and t.created_at >= ${from}::timestamptz` : sql``}
      ${to ? sql`and t.created_at <= ${to}::timestamptz` : sql``}
    order by t.created_at desc, t.id desc
  `);
  return { rows: result.rows.map((r): Record<string, unknown> => ({ ...r, issuedAt: new Date(String(r.issuedAt)).toISOString() })) };
}
