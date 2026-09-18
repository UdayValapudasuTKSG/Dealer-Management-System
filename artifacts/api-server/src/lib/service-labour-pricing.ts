import {
  FIXED_LABOUR_USD_PER_HOUR,
  type BrandLabourRate,
} from "@workspace/db";

export const MAX_BRAND_LABOUR_USD_PER_HOUR = 100_000;
export const MAX_LABOUR_BRANDS = 100;

export function canonicalServiceBrand(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en");
}

/**
 * The brand selector is an inventory taxonomy, not a settings taxonomy.
 * Keep this transformation separate from saved labour-rate overrides: old
 * overrides remain valid for pricing, but must not create new selector values.
 */
export function serviceBrandsFromInventoryMakes(
  makes: Array<string | null | undefined>,
): string[] {
  return [...new Set(
    makes
      .map((make) => (make == null ? "" : canonicalServiceBrand(make)))
      .filter((make) => make.length > 0),
  )].sort();
}

export function normalizeBrandLabourRates(value: BrandLabourRate[]): BrandLabourRate[] {
  if (value.length > MAX_LABOUR_BRANDS) {
    throw new Error(`At most ${MAX_LABOUR_BRANDS} brand labour rates are allowed`);
  }
  const seen = new Set<string>();
  return value.map((entry) => {
    const brand = canonicalServiceBrand(entry.brand);
    if (!brand || brand.length > 80) {
      throw new Error("Brand must contain 1–80 normalized characters");
    }
    if (seen.has(brand)) {
      throw new Error(`Duplicate brand labour rate: ${brand}`);
    }
    if (
      !Number.isFinite(entry.labourUsdPerHour) ||
      entry.labourUsdPerHour <= 0 ||
      entry.labourUsdPerHour > MAX_BRAND_LABOUR_USD_PER_HOUR
    ) {
      throw new Error(
        `Brand labour USD per hour must be finite, greater than 0, and at most ${MAX_BRAND_LABOUR_USD_PER_HOUR}`,
      );
    }
    seen.add(brand);
    return { brand, labourUsdPerHour: entry.labourUsdPerHour };
  });
}

export function labourUsdPerHourForBrand(
  brand: string | null | undefined,
  rates: BrandLabourRate[],
): number {
  const canonical = brand == null ? "" : canonicalServiceBrand(brand);
  return rates.find((rate) => rate.brand === canonical)?.labourUsdPerHour ??
    FIXED_LABOUR_USD_PER_HOUR;
}

/**
 * Labour pricing is the one deliberate USD input in the workshop workflow.
 * The result is immediately converted to a whole-GYD customer rate; no USD
 * amount is persisted or passed into quote/invoice calculations.
 */
export function calculateLabourRateGyd(
  labourUsdToGydRate: number,
  labourUsdPerHour = FIXED_LABOUR_USD_PER_HOUR,
): number {
  if (!Number.isFinite(labourUsdToGydRate) || labourUsdToGydRate <= 0) {
    throw new Error("Labour USD to GYD rate must be a positive finite number");
  }
  if (
    !Number.isFinite(labourUsdPerHour) ||
    labourUsdPerHour <= 0 ||
    labourUsdPerHour > MAX_BRAND_LABOUR_USD_PER_HOUR
  ) {
    throw new Error("Labour USD per hour must be a positive bounded finite number");
  }
  return Math.round(labourUsdPerHour * labourUsdToGydRate);
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
  labourUsdPerHour = FIXED_LABOUR_USD_PER_HOUR,
): number {
  if (customGydRate !== null && customGydRate !== undefined) {
    if (!Number.isFinite(customGydRate) || customGydRate < 0) {
      throw new Error("Custom labour rate must be a finite non-negative GYD amount");
    }
    return customGydRate;
  }
  return calculateLabourRateGyd(labourUsdToGydRate, labourUsdPerHour);
}
