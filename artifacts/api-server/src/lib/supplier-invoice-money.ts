/** All new invoice amounts are integer minor units, serialized as decimal strings. */
export function minor(value: string): bigint {
  if (!/^\d{1,12}(?:\.\d{1,2})?$/.test(value)) throw new Error("Money must be a nonnegative decimal with at most two decimal places");
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}
export function decimal(value: bigint): string {
  return `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`;
}
export function allocate(total: bigint, weights: bigint[]): bigint[] {
  const sum = weights.reduce((a, b) => a + b, 0n);
  if (!sum) {
    if (total) throw new Error("Shipping and duties cannot be allocated to zero-value lines");
    return weights.map(() => 0n);
  }
  const result = weights.map(w => total * w / sum);
  let pennies = total - result.reduce((a, b) => a + b, 0n);
  const rank = weights.map((w, i) => ({ i, remainder: total * w % sum }))
    .sort((a, b) => a.remainder === b.remainder ? a.i - b.i : a.remainder > b.remainder ? -1 : 1);
  for (const { i } of rank) { if (!pennies) break; result[i]++; pennies--; }
  return result;
}
export function flags(qty: number, received: number, cost: bigint, orderedCost: bigint, toleranceBps = 0): string[] {
  const result: string[] = [];
  const exceeds = (difference: bigint, baseline: bigint) => difference * 10000n > baseline * BigInt(toleranceBps);
  if (exceeds(BigInt(Math.abs(qty - received)), BigInt(received))) result.push("qty_variance");
  if (exceeds(cost > orderedCost ? cost - orderedCost : orderedCost - cost, orderedCost)) result.push("price_variance");
  return result;
}