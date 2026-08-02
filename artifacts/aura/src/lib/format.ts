import { useAuthz } from "./auth";

/**
 * Guyana localization helpers (DMS spec: GYD is the ONLY currency —
 * all amounts are stored and displayed in Guyana dollars; there is no
 * USD or exchange-rate concept. Dates in America/Guyana — GMT-4, no DST).
 */

export const GUYANA_TIME_ZONE = "America/Guyana";

const gydFormatter = new Intl.NumberFormat("en-GY", {
  style: "currency",
  currency: "GYD",
  currencyDisplay: "code",
  maximumFractionDigits: 0,
});

/** Format a GYD amount, e.g. "GYD 26,062,500". */
export function formatGYD(amountGyd: number): string {
  return gydFormatter.format(amountGyd);
}

/**
 * Hook: currency helpers. All amounts are GYD; `usd` and `dual` remain as
 * deprecated aliases of `gyd` so legacy call sites render GYD.
 */
export function useMoney() {
  // Auth context kept for parity with previous signature (dealer no longer
  // carries a currency rate — everything is GYD).
  useAuthz();
  return {
    /** @deprecated exchange rates removed; always 1 */
    rate: 1,
    gyd: (amountGyd: number) => formatGYD(amountGyd),
    /** @deprecated alias of gyd() */
    usd: (amountGyd: number) => formatGYD(amountGyd),
    /** @deprecated alias of gyd() */
    dual: (amountGyd: number) => formatGYD(amountGyd),
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
