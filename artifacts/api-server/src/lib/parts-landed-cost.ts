export type LandedCostComponents = {
  freight?: number;
  duty?: number;
  handling?: number;
  other?: number;
};

/** Components are allocated TOTAL-LINE amounts, not per-unit surcharges.
 * Keep unit precision: rounding before a partial receipt loses acquisition value. */
export function calculateLandedUnitCost(unitCost: number, quantity: number, components: LandedCostComponents = {}): number {
  if (!Number.isFinite(unitCost) || unitCost < 0) throw new Error("Unit cost must be finite and nonnegative");
  if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error("PO quantity must be a positive whole number");
  let allocated = 0;
  for (const [key, amount] of Object.entries(components)) {
    if (!["freight", "duty", "handling", "other"].includes(key)) throw new Error(`Unknown landed-cost component: ${key}`);
    if (amount === undefined) continue;
    if (!Number.isFinite(amount) || amount < 0) throw new Error(`Landed ${key} must be finite and nonnegative`);
    allocated += amount;
  }
  const result = unitCost + allocated / quantity;
  if (!Number.isFinite(result)) throw new Error("Landed unit cost exceeds supported range");
  return result;
}

/** Old PO lines without allocations preserve their recorded acquisition cost.
 * Lines with allocations always use the original ORDER quantity, not receipt qty. */
export function purchaseOrderReceiptUnitCost(line: {
  unitCost: number; quantity: number;
  landedCostComponents?: LandedCostComponents | null; landedUnitCost?: number | null;
}): number {
  if (line.landedCostComponents && Object.keys(line.landedCostComponents).length) {
    return calculateLandedUnitCost(line.unitCost, line.quantity, line.landedCostComponents);
  }
  return calculateLandedUnitCost(line.landedUnitCost ?? line.unitCost, line.quantity);
}