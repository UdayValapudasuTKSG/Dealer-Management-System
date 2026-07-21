import { useAuthz } from "./auth";

/**
 * Guyana localization helpers (DMS spec: GYD primary currency, per-dealer
 * USD exchange rate, all dates in America/Guyana — GMT-4, no DST).
 *
 * Monetary amounts are STORED in USD throughout the system; the dealer's
 * `usdExchangeRate` (GYD per 1 USD) converts them for display.
 */

export const DEFAULT_USD_EXCHANGE_RATE = 208.5;
export const GUYANA_TIME_ZONE = "America/Guyana";

const gydFormatter = new Intl.NumberFormat("en-GY", {
  style: "currency",
  currency: "GYD",
  currencyDisplay: "code",
  maximumFractionDigits: 0,
});

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

/** Format an amount already denominated in GYD, e.g. "GYD 26,062,500". */
export function formatGYD(amountGyd: number): string {
  return gydFormatter.format(amountGyd);
}

/** Format an amount denominated in USD, e.g. "$125,000". */
export function formatUSD(amountUsd: number): string {
  return usdFormatter.format(amountUsd);
}

/** Convert a stored USD amount to GYD text using the dealer's rate. */
export function usdToGydText(
  amountUsd: number,
  rate: number = DEFAULT_USD_EXCHANGE_RATE,
): string {
  return formatGYD(amountUsd * rate);
}

/** "GYD 26,062,500 (US$125,000)" — primary GYD with USD reference. */
export function dualCurrencyText(
  amountUsd: number,
  rate: number = DEFAULT_USD_EXCHANGE_RATE,
): string {
  return `${usdToGydText(amountUsd, rate)} (${formatUSD(amountUsd)})`;
}

/**
 * Hook: currency helpers bound to the active dealer's USD exchange rate.
 * Falls back to the platform default when no dealer is active.
 */
export function useMoney() {
  const { activeDealer } = useAuthz();
  const rate = activeDealer?.usdExchangeRate ?? DEFAULT_USD_EXCHANGE_RATE;
  return {
    rate,
    /** stored-USD amount → primary GYD display text */
    gyd: (amountUsd: number) => usdToGydText(amountUsd, rate),
    /** stored-USD amount → USD display text */
    usd: (amountUsd: number) => formatUSD(amountUsd),
    /** stored-USD amount → "GYD … (US$…)" */
    dual: (amountUsd: number) => dualCurrencyText(amountUsd, rate),
  };
}

// ---------------------------------------------------------------------------
// Dates — always rendered in Guyana time (GMT-4)
// ---------------------------------------------------------------------------

type DateInput = string | number | Date | null | undefined;

function toDate(value: DateInput): Date | null {
  if (value == null || value === "") return null;
  // Date-only strings (YYYY-MM-DD) are UTC midnight; keep the calendar date
  // rather than shifting a day when rendered in GMT-4.
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split("-").map(Number);
    return new Date(Date.UTC(y!, m! - 1, d!, 12));
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "Jul 21, 2026" in Guyana time. */
export function formatGuyanaDate(value: DateInput): string {
  const date = toDate(value);
  if (!date) return "—";
  return date.toLocaleDateString("en-US", {
    timeZone: GUYANA_TIME_ZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** "Jul 21, 2026, 2:30 PM" in Guyana time. */
export function formatGuyanaDateTime(value: DateInput): string {
  const date = toDate(value);
  if (!date) return "—";
  return date.toLocaleString("en-US", {
    timeZone: GUYANA_TIME_ZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "2:30 PM" in Guyana time. */
export function formatGuyanaTime(value: DateInput): string {
  const date = toDate(value);
  if (!date) return "—";
  return date.toLocaleTimeString("en-US", {
    timeZone: GUYANA_TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
  });
}
