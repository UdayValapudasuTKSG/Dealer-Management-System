import { useAuthz } from "./auth";

/**
 * Localization helpers (DMS spec: GYD is the ONLY currency — all amounts are
 * stored and displayed in Guyana dollars). Dates render in the ACTIVE
 * DEALERSHIP'S configured timezone (Settings → Localization); the historical
 * default is America/Guyana (GMT-4, no DST).
 */

export const GUYANA_TIME_ZONE = "America/Guyana";
export const DEFAULT_TIME_ZONE = GUYANA_TIME_ZONE;

// ---------------------------------------------------------------------------
// Active dealership timezone (Task 266). AuthProvider sets this from the
// active dealer's `timezone` field as soon as the session (or a dealership
// switch) resolves; every formatter below reads it. Module-level is safe:
// a dealer switch resets ALL queries, so every consumer re-renders anyway.
// ---------------------------------------------------------------------------

let activeTimeZone = DEFAULT_TIME_ZONE;

/**
 * Set the active dealership timezone. Called SYNCHRONOUSLY during
 * AuthProvider's render (before any child renders), so the same render pass
 * that observes a new `activeDealer.timezone` already formats with it.
 * Returns true when the zone actually changed (AuthProvider then refreshes
 * timezone-sensitive queries).
 */
export function setActiveTimeZone(tz: string | null | undefined): boolean {
  let next = DEFAULT_TIME_ZONE;
  if (tz) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      next = tz;
    } catch {
      next = DEFAULT_TIME_ZONE;
    }
  }
  const changed = next !== activeTimeZone;
  activeTimeZone = next;
  return changed;
}

/** The active dealership's IANA timezone. */
export function activeDealerTimeZone(): string {
  return activeTimeZone;
}

/** "YYYY-MM-DD" calendar-day key of an instant in the dealer timezone. */
export function dealerDayKey(date: Date = new Date()): string {
  return date.toLocaleDateString("en-CA", { timeZone: activeTimeZone });
}

/** Wall-clock parts of an instant in the dealer timezone. */
export function dealerDateParts(date: Date = new Date()): {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
} {
  const raw: Record<string, string> = {};
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: activeTimeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  for (const p of fmt.formatToParts(date)) raw[p.type] = p.value;
  return {
    year: Number(raw.year),
    month: Number(raw.month),
    day: Number(raw.day),
    hour: Number(raw.hour) === 24 ? 0 : Number(raw.hour),
    minute: Number(raw.minute),
  };
}

/** Day key shifted by N calendar days in the dealer timezone. */
export function dealerDayKeyPlus(days: number, from: Date = new Date()): string {
  const [y, m, d] = dealerDayKey(from).split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days, 12)).toISOString().slice(0, 10);
}

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
// Dates — rendered in the active dealership timezone
// ---------------------------------------------------------------------------

type DateInput = string | number | Date | null | undefined;

/** Date-only strings are calendar dates — format them timezone-agnostically. */
const isDateOnly = (value: DateInput): boolean =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

/**
 * Normalize an API date value to its calendar-day key.
 *
 * OpenAPI date responses can arrive as a full UTC-midnight ISO string even
 * though the database value has no time zone. Reading the first ISO date
 * segment preserves the selected calendar day instead of shifting it into the
 * previous evening for dealerships west of UTC.
 */
export function calendarDateKey(value: DateInput): string | null {
  if (value == null || value === "") return null;
  if (typeof value === "string") {
    const key = value.slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(key) ? key : null;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

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

/** "Jul 21, 2026" in the dealership timezone. */
export function formatGuyanaDate(value: DateInput): string {
  const date = toDate(value);
  if (!date) return "—";
  return date.toLocaleDateString("en-US", {
    timeZone: isDateOnly(value) ? "UTC" : activeTimeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** "Jul 21, 2026, 2:30 PM" in the dealership timezone. */
export function formatGuyanaDateTime(value: DateInput): string {
  const date = toDate(value);
  if (!date) return "—";
  return date.toLocaleString("en-US", {
    timeZone: activeTimeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "Jul 21" (no year) in the dealership timezone. */
export function formatDealerDateShort(value: DateInput): string {
  const date = toDate(value);
  if (!date) return "—";
  return date.toLocaleDateString("en-US", {
    timeZone: isDateOnly(value) ? "UTC" : activeTimeZone,
    month: "short",
    day: "numeric",
  });
}

/** "Jul 21" for a calendar date, including API-coerced UTC-midnight values. */
export function formatCalendarDateShort(value: DateInput): string {
  const key = calendarDateKey(value);
  if (!key) return "—";
  const [year, month, day] = key.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!, 12)).toLocaleDateString(
    "en-US",
    {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
    },
  );
}

/** "Jul 21, 2:30 PM" (no year) in the dealership timezone. */
export function formatDealerDayTime(value: DateInput): string {
  const date = toDate(value);
  if (!date) return "—";
  return date.toLocaleString("en-US", {
    timeZone: activeTimeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "Jul 2026" in the dealership timezone. */
export function formatDealerMonthYear(value: DateInput): string {
  const date = toDate(value);
  if (!date) return "—";
  return date.toLocaleDateString("en-US", {
    timeZone: isDateOnly(value) ? "UTC" : activeTimeZone,
    month: "short",
    year: "numeric",
  });
}

/** "2:30 PM" in the dealership timezone. */
export function formatGuyanaTime(value: DateInput): string {
  const date = toDate(value);
  if (!date) return "—";
  return date.toLocaleTimeString("en-US", {
    timeZone: activeTimeZone,
    hour: "numeric",
    minute: "2-digit",
  });
}
