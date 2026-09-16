import { FIXED_LABOUR_USD_PER_HOUR } from "@workspace/db";

/**
 * Labour pricing is the one deliberate USD input in the workshop workflow.
 * The result is immediately converted to a whole-GYD customer rate; no USD
 * amount is persisted or passed into quote/invoice calculations.
 */
export function calculateLabourRateGyd(labourUsdToGydRate: number): number {
  if (!Number.isFinite(labourUsdToGydRate) || labourUsdToGydRate <= 0) {
    throw new Error("Labour USD to GYD rate must be a positive finite number");
  }
  return Math.round(FIXED_LABOUR_USD_PER_HOUR * labourUsdToGydRate);
}

export function isValidLabourUsdToGydRate(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * Resolve a new card's GYD rate. A caller-supplied value is already a
 * customer-facing GYD override and is retained; only an omitted value is
 * derived from the dealer's labour-only FX setting.
 */
export function resolveNewCardLabourRate(
  customGydRate: number | null | undefined,
  labourUsdToGydRate: number,
): number {
  if (customGydRate !== null && customGydRate !== undefined) {
    if (!Number.isFinite(customGydRate) || customGydRate < 0) {
      throw new Error("Custom labour rate must be a finite non-negative GYD amount");
    }
    return customGydRate;
  }
  return calculateLabourRateGyd(labourUsdToGydRate);
}
