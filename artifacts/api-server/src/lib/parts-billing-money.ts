/** All new persisted amounts are decimal strings. Reject rather than coerce bad prices. */
export function moneyMinor(value: unknown): number {
  const text = String(value);
  if (!/^\d{1,12}(?:\.\d{1,2})?$/.test(text)) throw new Error("Amount must be non-negative with at most two decimal places");
  const [whole, fraction = ""] = text.split(".");
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(minor)) throw new Error("Amount exceeds supported precision");
  return minor;
}

export function decimalMoney(minor: number): string {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new Error("Invalid minor-unit amount");
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;
}

export function nonTaxChargeLines(shipping: number, duties: number) {
  return [
    ...(shipping ? [{ kind: "surcharge" as const, description: "Shipping", quantity: 1, amount: shipping }] : []),
    ...(duties ? [{ kind: "surcharge" as const, description: "Duties", quantity: 1, amount: duties }] : []),
  ];
}

export function assertDepositCreditWithinBalances(minor: number, availableMinor: number, dueMinor: number) {
  if (![minor, availableMinor, dueMinor].every(Number.isSafeInteger) ||
      minor <= 0 || minor > availableMinor || minor > dueMinor) {
    throw Object.assign(new Error("Deposit credit exceeds the available deposited balance or invoice balance"), { status: 422 });
  }
}