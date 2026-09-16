/**
 * Resolve the customer-facing labour hours without collapsing an explicit
 * zero-hour quote into the planned booking hours. Null/undefined means that
 * the card has no override yet and must retain its planned hours.
 */
export function effectiveQuotedLaborHours(
  quotedLaborHours: number | null | undefined,
  laborHours: number,
): number {
  return quotedLaborHours ?? laborHours;
}

export function calculateQuotedLaborTotal(
  quotedLaborHours: number | null | undefined,
  laborHours: number,
  laborRate: number,
): number {
  return Math.round(
    effectiveQuotedLaborHours(quotedLaborHours, laborHours) * laborRate * 100,
  ) / 100;
}