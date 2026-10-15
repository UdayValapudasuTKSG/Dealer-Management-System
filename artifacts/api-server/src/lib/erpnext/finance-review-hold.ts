export const FINANCE_REVIEW_HOLD_MESSAGE =
  "Finance review hold: this legacy financial record requires Finance review; ordinary Retry cannot release it.";

export function isFinanceReviewHeld(payload: Record<string, unknown> | null | undefined): boolean {
  // Presence, not truthiness: malformed or false flags must never clear a hold.
  return !!payload && Object.prototype.hasOwnProperty.call(payload, "financeReviewHold");
}

export class FinanceReviewHoldError extends Error {
  constructor() { super(FINANCE_REVIEW_HOLD_MESSAGE); }
}
