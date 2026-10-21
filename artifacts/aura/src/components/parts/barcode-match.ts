/** Preserve leading zeroes and punctuation. Never use substring matching to
 * select a stock record; ambiguous barcode/SKU collisions require human choice. */
export function matchingParts<T extends { sku: string; barcode?: string | null }>(parts: T[], raw: string): T[] {
  const code = raw.trim();
  if (!code) return [];
  return parts.filter(part => part.barcode?.trim() === code || part.sku.trim().toLowerCase() === code.toLowerCase());
}
