/**
 * Central sales-finance pilot boundary. LEAF module: imports only drizzle and
 * @workspace/db so invoicing, ERPNext handlers, holds and routes can all use
 * it without import cycles. Every check runs on the caller's executor (tx or
 * db), so it never takes an extra pool connection inside a transaction.
 */
import { sql } from "drizzle-orm";
import type { db as Db } from "@workspace/db";

type Exec = Pick<typeof Db, "execute">;

/** Production: exactly dealer 2 "CAM Motors Dummy". Development additionally
 * admits isolated "CAM Motors Dummy (dev fixture ...)" dealers. */
export function pilotDealerName(dealerId: number, name: string | null | undefined): boolean {
  const n = (name ?? "").trim().toLowerCase();
  if (process.env.NODE_ENV === "production") return dealerId === 2 && n === "cam motors dummy";
  return n === "cam motors dummy" || n.startsWith("cam motors dummy (dev fixture");
}

export async function isPilotDealerExec(exec: Exec, dealerId: number): Promise<boolean> {
  const r = await exec.execute(sql`SELECT name FROM dealers WHERE id = ${dealerId}`);
  const row = r.rows[0] as { name?: string } | undefined;
  return pilotDealerName(dealerId, row?.name);
}

/** Vehicle-sale document: linked to a deal, or a booking reservation fee.
 * Service and parts invoices (no deal, not a booking) are never in scope. */
export function isSalesInvoiceShape(inv: { dealId: number | null; description?: string | null }): boolean {
  return inv.dealId != null || /\(booking #\d+\)/i.test(inv.description ?? "");
}

/** True when this invoice may only receive receipts/postings through an
 * approved sales-finance request — enrolled or not. */
export async function isPilotSalesInvoice(exec: Exec, inv: { dealerId: number; dealId: number | null; description?: string | null }): Promise<boolean> {
  return isSalesInvoiceShape(inv) && isPilotDealerExec(exec, inv.dealerId);
}
