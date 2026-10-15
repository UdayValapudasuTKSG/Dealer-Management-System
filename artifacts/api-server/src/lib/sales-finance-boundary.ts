/**
 * Central forward-only sales-finance rollout boundary. LEAF module: imports only drizzle and
 * @workspace/db so invoicing, ERPNext handlers, holds and routes can all use
 * it without import cycles. Every check runs on the caller's executor (tx or
 * db), so it never takes an extra pool connection inside a transaction.
 */
import { sql } from "drizzle-orm";
import type { db as Db } from "@workspace/db";

type Exec = Pick<typeof Db, "execute">;

/** Call before listening/starting workers. Concurrent instances retain one cutoff. */
export async function initializeSalesFinanceRollout(exec: Exec): Promise<void> {
  await exec.execute(sql`INSERT INTO sales_finance_rollout (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
}

/** Preserve the original dummy rollout's existing protections. This is NOT
 * the all-dealer access check; it only grandfathers already-active safeguards. */
export function pilotDealerName(dealerId: number, name: string | null | undefined): boolean {
  const n = (name ?? "").trim().toLowerCase();
  if (process.env.NODE_ENV === "production") return dealerId === 2 && n === "cam motors dummy";
  return n === "cam motors dummy" || n.startsWith("cam motors dummy (dev fixture");
}

export async function isPilotDealerExec(exec: Exec, dealerId: number): Promise<boolean> {
  const r = await exec.execute(sql`SELECT id FROM dealers WHERE id = ${dealerId}`);
  return r.rows.length === 1;
}

/** Scope the sale, not the invoice date: new invoices for old deals stay legacy.
 * A pre-activation booking converted later remains an existing sale too.
 * Explicitly enrolled deals and the original dummy pilot keep their protections.
 */
export async function requiresDealFinanceApproval(exec: Exec, dealerId: number, dealId: number): Promise<boolean> {
  const rows = await dealScopes(exec, dealerId, dealId);
  return rows.some(row => scopedDeal(dealerId, row));
}

type DealScope = { id: number; name: string; after_activation: boolean; enrolled: boolean; old_booking: boolean };
function scopedDeal(dealerId: number, row: DealScope) {
  return row.enrolled || pilotDealerName(dealerId, row.name) ||
    (!row.old_booking && row.after_activation);
}

export async function financeApprovalDealIds(exec: Exec, dealerId: number): Promise<Set<number>> {
  return new Set((await dealScopes(exec, dealerId)).filter(row => scopedDeal(dealerId, row)).map(row => row.id));
}

async function dealScopes(exec: Exec, dealerId: number, dealId?: number): Promise<DealScope[]> {
  const result = await exec.execute(sql`
    SELECT d.id, dealer.name, (d.created_at >= r.activated_at) AS after_activation,
      EXISTS (SELECT 1 FROM sales_accounting_workflows w WHERE w.dealer_id=d.dealer_id AND w.deal_id=d.id) AS enrolled,
      EXISTS (SELECT 1 FROM bookings b WHERE b.dealer_id=d.dealer_id AND b.deal_id=d.id AND b.created_at < r.activated_at) AS old_booking
    FROM deals d JOIN dealers dealer ON dealer.id=d.dealer_id
    CROSS JOIN sales_finance_rollout r
    WHERE ${dealId === undefined ? sql`true` : sql`d.id=${dealId}`} AND d.dealer_id=${dealerId} AND r.id=1`);
  if (!result.rows.length) {
    const marker = await exec.execute(sql`SELECT id FROM sales_finance_rollout WHERE id=1`);
    if (!marker.rows.length) throw new Error("Sales finance rollout is not initialized; refusing an ambiguous sale scope");
  }
  return result.rows as DealScope[];
}

/** Vehicle-sale document: linked to a deal, or a booking reservation fee.
 * Service and parts invoices (no deal, not a booking) are never in scope. */
export function isSalesInvoiceShape(inv: { dealId: number | null; description?: string | null }): boolean {
  return inv.dealId != null || /\(booking #\d+\)/i.test(inv.description ?? "");
}

/** True when this invoice may only receive receipts/postings through an
 * approved sales-finance request — enrolled or not. */
export async function isPilotSalesInvoice(exec: Exec, inv: { dealerId: number; dealId: number | null; description?: string | null }): Promise<boolean> {
  if (inv.dealId != null) return requiresDealFinanceApproval(exec, inv.dealerId, inv.dealId);
  const bookingId = inv.description?.match(/\(booking #(\d+)\)/i)?.[1];
  if (!bookingId) return false;
  const dealer = await exec.execute(sql`SELECT name FROM dealers WHERE id=${inv.dealerId}`);
  if (pilotDealerName(inv.dealerId, (dealer.rows[0] as { name?: string } | undefined)?.name)) return true;
  const result = await exec.execute(sql`
    SELECT b.deal_id, dealer.name, (b.created_at >= r.activated_at) AS after_activation
    FROM bookings b JOIN dealers dealer ON dealer.id=b.dealer_id CROSS JOIN sales_finance_rollout r
    WHERE b.id=${Number(bookingId)} AND b.dealer_id=${inv.dealerId} AND r.id=1`);
  const row = result.rows[0] as { deal_id: number | null; name: string; after_activation: boolean } | undefined;
  if (!row) throw new Error("Booking origin or sales finance activation is missing; review before recording or posting");
  if (row.deal_id) return requiresDealFinanceApproval(exec, inv.dealerId, row.deal_id);
  return row.after_activation;
}
