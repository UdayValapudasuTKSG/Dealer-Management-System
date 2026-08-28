import { db, dealersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Task 266 — dealership timezone helpers.
//
// Every dealership renders dates/times, computes calendar-day boundaries and
// builds schedules in ITS OWN IANA timezone (dealers.timezone). Timestamps
// stay stored in UTC — these helpers only affect presentation/derivation.
// All helpers are DST-safe: wall-clock conversion probes the zone offset at
// the target instant and re-probes once across transitions.
// ---------------------------------------------------------------------------

export const DEFAULT_TIMEZONE = "America/Guyana";

/** True when tz is a recognized IANA timezone identifier in this runtime. */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Small TTL cache — timezone is read on nearly every request path that
// formats a date, and settings changes must land within seconds.
const TZ_CACHE_TTL_MS = 30_000;
const tzCache = new Map<number, { tz: string; expires: number }>();

/** The dealership's IANA timezone (cached ~30s; Guyana default fallback). */
export async function dealerTimezone(dealerId: number): Promise<string> {
  const hit = tzCache.get(dealerId);
  if (hit && hit.expires > Date.now()) return hit.tz;
  const [row] = await db
    .select({ timezone: dealersTable.timezone })
    .from(dealersTable)
    .where(eq(dealersTable.id, dealerId));
  const tz =
    row?.timezone && isValidTimezone(row.timezone)
      ? row.timezone
      : DEFAULT_TIMEZONE;
  tzCache.set(dealerId, { tz, expires: Date.now() + TZ_CACHE_TTL_MS });
  return tz;
}

/** Drop the cached timezone after a settings change so it applies at once. */
export function invalidateDealerTimezone(dealerId: number): void {
  tzCache.delete(dealerId);
}

type Parts = {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday … 6 = Saturday
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const partsFmtCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let fmt = partsFmtCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    partsFmtCache.set(tz, fmt);
  }
  return fmt;
}

/** Wall-clock parts of a UTC instant in the given timezone. */
export function zonedParts(date: Date, tz: string): Parts {
  const raw: Record<string, string> = {};
  for (const p of partsFormatter(tz).formatToParts(date)) raw[p.type] = p.value;
  return {
    year: Number(raw.year),
    month: Number(raw.month),
    day: Number(raw.day),
    hour: Number(raw.hour) === 24 ? 0 : Number(raw.hour),
    minute: Number(raw.minute),
    second: Number(raw.second),
    weekday: WEEKDAYS.indexOf(raw.weekday ?? "Sun"),
  };
}

/** Zone offset (ms east of UTC) at the given instant. */
function tzOffsetMs(date: Date, tz: string): number {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * The UTC instant of a wall-clock time in the given timezone.
 * DST-safe: re-probes the offset once across transitions (spring-forward
 * gaps resolve to the post-transition instant).
 */
export function zonedTimeToUtc(
  tz: string,
  year: number,
  month: number, // 1-12
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): Date {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset1 = tzOffsetMs(new Date(utcGuess), tz);
  let ts = utcGuess - offset1;
  const offset2 = tzOffsetMs(new Date(ts), tz);
  if (offset2 !== offset1) {
    const candidate = utcGuess - offset2;
    // If the re-probed candidate round-trips to the requested wall clock,
    // the guess simply straddled a transition. Otherwise the requested time
    // falls inside a spring-forward gap — map it to the post-transition
    // instant (e.g. 2:30 AM in a 2→3 AM gap becomes 3:30 AM) by using the
    // pre-transition (smaller) offset.
    ts =
      tzOffsetMs(new Date(candidate), tz) === offset2
        ? candidate
        : utcGuess - Math.min(offset1, offset2);
  }
  return new Date(ts);
}

/** "YYYY-MM-DD" calendar-day key of an instant in the given timezone. */
export function zonedDayKey(date: Date, tz: string): string {
  const p = zonedParts(date, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** UTC instant of local midnight starting the given day key (or instant). */
export function zonedStartOfDay(value: Date | string, tz: string): Date {
  const key = typeof value === "string" ? value : zonedDayKey(value, tz);
  const [y, m, d] = key.split("-").map(Number);
  return zonedTimeToUtc(tz, y!, m!, d!);
}

/** Local calendar date `days` after (or before) the instant, as a day key. */
export function zonedAddDays(date: Date, tz: string, days: number): string {
  const p = zonedParts(date, tz);
  const shifted = new Date(Date.UTC(p.year, p.month - 1, p.day + days, 12));
  return shifted.toISOString().slice(0, 10);
}

/**
 * Normalize a date-ish value for FORMATTING: date-only strings (YYYY-MM-DD)
 * pin to UTC noon so the calendar date never shifts a day in any zone.
 */
export function toDisplayDate(
  value: string | number | Date | null | undefined,
): Date | null {
  if (value == null || value === "") return null;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split("-").map(Number);
    return new Date(Date.UTC(y!, m! - 1, d!, 12));
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** True when `value` is a date-only string (rendered timezone-agnostically). */
const isDateOnly = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

type DateInput = string | number | Date | null | undefined;

/** "Jul 21, 2026" in the dealer timezone. */
export function formatDealerDate(value: DateInput, tz: string): string {
  const d = toDisplayDate(value);
  if (!d) return "—";
  return d.toLocaleDateString("en-US", {
    timeZone: isDateOnly(value) ? "UTC" : tz,
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** "Monday, July 21" style long date in the dealer timezone. */
export function formatDealerLongDate(value: DateInput, tz: string): string {
  const d = toDisplayDate(value);
  if (!d) return "—";
  return d.toLocaleDateString("en-US", {
    timeZone: isDateOnly(value) ? "UTC" : tz,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

/** "Jul 21, 2026, 2:30 PM" in the dealer timezone. */
export function formatDealerDateTime(value: DateInput, tz: string): string {
  const d = toDisplayDate(value);
  if (!d) return "—";
  return d.toLocaleString("en-US", {
    timeZone: tz,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "2:30 PM" in the dealer timezone. */
export function formatDealerTime(value: DateInput, tz: string): string {
  const d = toDisplayDate(value);
  if (!d) return "—";
  return d.toLocaleTimeString("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "Monday, July 21 at 2:30 PM" — schedules/confirmations wording. */
export function formatDealerSlot(value: Date, tz: string): string {
  return `${value.toLocaleDateString("en-US", {
    timeZone: tz,
    weekday: "long",
    month: "long",
    day: "numeric",
  })} at ${formatDealerTime(value, tz)}`;
}
