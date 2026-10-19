import { db, dealersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

/** Explicitly approved dummy-only policy. Never infer this from a dealer name
 * alone or propagate it to other dealerships. No retrospective queue replay. */
export const FINAL_INVOICE_VAT_POLICY = "final_invoice_14" as const;
export function isApprovedAdvanceDealer(id: number, name: string) {
  return id === 2 && name.trim().toLowerCase() === "cam motors dummy";
}
export async function hasApprovedAdvancePolicy(dealerId: number) {
  if (dealerId !== 2) return false;
  const [dealer] = await db.select({ name: dealersTable.name }).from(dealersTable).where(eq(dealersTable.id, dealerId));
  return !!dealer && isApprovedAdvanceDealer(dealerId, dealer.name);
}
export type AdvanceApplication = { requestId: number; amountCents: number };

/** Allocate oldest receipts first, in integer cents; callers reserve these
 * allocations under the dealer's submission/approval lock. */
export function allocateAdvances(
  receipts: { id: number; amountCents: number }[],
  used: AdvanceApplication[],
  cap: number,
): AdvanceApplication[] {
  const result: AdvanceApplication[] = [];
  let remaining = cap;
  for (const receipt of [...receipts].sort((a, b) => a.id - b.id)) {
    const available = receipt.amountCents - used.filter(a => a.requestId === receipt.id).reduce((s, a) => s + a.amountCents, 0);
    if (available < 0) throw new Error("Deposit applications exceed the posted deposit; Finance reconciliation is required.");
    const amountCents = Math.min(available, remaining);
    if (amountCents > 0) result.push({ requestId: receipt.id, amountCents });
    remaining -= amountCents;
  }
  return result;
}
