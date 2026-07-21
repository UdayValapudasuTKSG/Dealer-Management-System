import { useAuthz } from "./auth";

/**
 * Localization helpers for Guyana (per DMS spec):
 * - Currency: GYD primary, USD secondary using the dealer's exchange rate.
 *   Stored amounts are USD-scale; GYD display = amount x rate.
 * - Timezone: GMT-4 (America/Guyana), no daylight saving.
 */

export const GUYANA_TZ = "America/Guyana";
export const DEFAULT_USD_RATE = 209;

export function formatGyd(usdAmount: number, rate: number): string {
  const gyd = usdAmount * rate;
  return `GY$${Math.round(gyd).toLocaleString("en-GY")}`;
}

export function formatUsd(usdAmount: number): string {
  return `US$${usdAmount.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

/** "GY$9,405,000 (US$45,000)" — GYD primary, USD secondary. */
export function formatMoney(usdAmount: number, rate: number): string {
  return `${formatGyd(usdAmount, rate)} (${formatUsd(usdAmount)})`;
}

export function formatGuyanaDate(
  value: string | Date,
  options: Intl.DateTimeFormatOptions = { dateStyle: "medium" },
): string {
  const d = typeof value === "string" ? new Date(value) : value;
  return d.toLocaleString("en-GY", { timeZone: GUYANA_TZ, ...options });
}

export function formatGuyanaDateTime(value: string | Date): string {
  return formatGuyanaDate(value, { dateStyle: "medium", timeStyle: "short" });
}

/** Dealer-aware money formatting bound to the active dealer's USD rate. */
export function useMoney() {
  const { activeDealer } = useAuthz();
  const rate = activeDealer?.usdExchangeRate ?? DEFAULT_USD_RATE;
  return {
    rate,
    gyd: (usdAmount: number) => formatGyd(usdAmount, rate),
    usd: formatUsd,
    money: (usdAmount: number) => formatMoney(usdAmount, rate),
  };
}
