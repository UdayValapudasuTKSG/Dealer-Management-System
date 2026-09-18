export const DEFAULT_LABOUR_USD_PER_HOUR = 120;

export type BrandLabourRate = {
  brand: string;
  labourUsdPerHour: number;
};

export function normalizeLabourBrand(brand: string): string {
  return brand.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function effectiveBrandLabourUsdRate(
  brand: string | null | undefined,
  rates: readonly BrandLabourRate[],
): number {
  const normalizedBrand = normalizeLabourBrand(brand ?? "");
  if (!normalizedBrand) return DEFAULT_LABOUR_USD_PER_HOUR;
  return (
    rates.find((rate) => normalizeLabourBrand(rate.brand) === normalizedBrand)
      ?.labourUsdPerHour ?? DEFAULT_LABOUR_USD_PER_HOUR
  );
}

export function sortedUniqueBrands(brands: readonly (string | null | undefined)[]): string[] {
  const byNormalizedName = new Map<string, string>();
  for (const rawBrand of brands) {
    const brand = (rawBrand ?? "").trim().replace(/\s+/g, " ");
    const normalized = normalizeLabourBrand(brand);
    if (normalized && !byNormalizedName.has(normalized)) {
      byNormalizedName.set(normalized, brand);
    }
  }
  return [...byNormalizedName.values()].sort((left, right) =>
    left.localeCompare(right, undefined, { sensitivity: "base" }),
  );
}