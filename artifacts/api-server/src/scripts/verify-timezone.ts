/**
 * verify-timezone — boundary tests for the dealership timezone helpers.
 *
 * Covers wall-clock→UTC conversion across DST spring-forward gaps and
 * fall-back overlaps, midnight-transition zones, day-key stability across
 * midnight boundaries, and date-only formatting that must never shift a day.
 * Pure-function suite: no server or fixtures required.
 */
import {
  zonedTimeToUtc,
  zonedParts,
  zonedDayKey,
  zonedStartOfDay,
  zonedAddDays,
  formatDealerDate,
  formatDealerTime,
  isValidTimezone,
} from "../lib/timezone";
import { addBusinessDays } from "../routes/deliveries";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` — expected ${String(expected)}, got ${String(actual)}`}`);
}

// --- Round trips in fixed-offset and DST zones -----------------------------
check(
  "Guyana wall clock round-trips (GMT-4, no DST)",
  zonedTimeToUtc("America/Guyana", 2026, 8, 28, 9, 30).toISOString(),
  "2026-08-28T13:30:00.000Z",
);
check(
  "NY summer (EDT) 9:00 -> 13:00Z",
  zonedTimeToUtc("America/New_York", 2026, 7, 1, 9, 0).toISOString(),
  "2026-07-01T13:00:00.000Z",
);
check(
  "NY winter (EST) 9:00 -> 14:00Z",
  zonedTimeToUtc("America/New_York", 2026, 1, 15, 9, 0).toISOString(),
  "2026-01-15T14:00:00.000Z",
);
check(
  "Tokyo 9:00 -> previous-day 00:00Z",
  zonedTimeToUtc("Asia/Tokyo", 2026, 8, 28, 9, 0).toISOString(),
  "2026-08-28T00:00:00.000Z",
);

// --- Spring-forward gap: 2026-03-08 02:30 does not exist in New York -------
// Post-transition mapping: 2:30 in the 2->3 AM gap becomes 3:30 EDT (07:30Z).
const gap = zonedTimeToUtc("America/New_York", 2026, 3, 8, 2, 30);
check("NY spring gap 2:30 maps to 07:30Z (3:30 EDT)", gap.toISOString(), "2026-03-08T07:30:00.000Z");
const gapParts = zonedParts(gap, "America/New_York");
check("NY spring gap renders post-transition hour", `${gapParts.hour}:${gapParts.minute}`, "3:30");
// Times adjacent to the gap stay exact.
check(
  "NY 1:59 before gap stays EST",
  zonedTimeToUtc("America/New_York", 2026, 3, 8, 1, 59).toISOString(),
  "2026-03-08T06:59:00.000Z",
);
check(
  "NY 3:00 after gap is EDT",
  zonedTimeToUtc("America/New_York", 2026, 3, 8, 3, 0).toISOString(),
  "2026-03-08T07:00:00.000Z",
);

// --- Fall-back overlap: 2026-11-01 01:30 occurs twice in New York ----------
// Either mapping is acceptable; it must round-trip to the requested wall clock.
const overlap = zonedTimeToUtc("America/New_York", 2026, 11, 1, 1, 30);
const overlapParts = zonedParts(overlap, "America/New_York");
check("NY fall-back 1:30 round-trips wall clock", `${overlapParts.hour}:${overlapParts.minute}`, "1:30");
check(
  "NY fall-back 1:30 is one of the two valid instants",
  ["2026-11-01T05:30:00.000Z", "2026-11-01T06:30:00.000Z"].includes(overlap.toISOString()),
  true,
);

// --- Midnight-transition zone: Santiago springs forward at 24:00 -----------
// 2026-09-06 00:30 does not exist in America/Santiago (00:00 -> 01:00).
const scl = zonedTimeToUtc("America/Santiago", 2026, 9, 6, 0, 30);
const sclParts = zonedParts(scl, "America/Santiago");
check("Santiago midnight-gap 00:30 maps into post-transition hour", sclParts.hour, 1);
check("Santiago midnight-gap stays on the requested calendar day", zonedDayKey(scl, "America/Santiago"), "2026-09-06");
check(
  "Santiago start-of-day on gap date is 01:00 local",
  zonedParts(zonedStartOfDay("2026-09-06", "America/Santiago"), "America/Santiago").hour,
  1,
);

// --- Day keys across midnight boundaries -----------------------------------
const lateNight = new Date("2026-08-28T03:30:00Z"); // 23:30 Aug 27 in Guyana
check("03:30Z is still Aug 27 in Guyana", zonedDayKey(lateNight, "America/Guyana"), "2026-08-27");
check("03:30Z is Aug 28 in Tokyo", zonedDayKey(lateNight, "Asia/Tokyo"), "2026-08-28");
check("addDays crosses the local midnight, not UTC's", zonedAddDays(lateNight, "America/Guyana", 1), "2026-08-28");
check("start of Guyana day is 04:00Z", zonedStartOfDay("2026-08-28", "America/Guyana").toISOString(), "2026-08-28T04:00:00.000Z");
// DST-transition day is 23 hours long; next local midnight must still be day+1.
const nyDstMidnight = zonedStartOfDay("2026-03-08", "America/New_York");
check("NY DST day start", nyDstMidnight.toISOString(), "2026-03-08T05:00:00.000Z");
check(
  "day after 23h DST day",
  zonedDayKey(zonedStartOfDay("2026-03-09", "America/New_York"), "America/New_York"),
  "2026-03-09",
);

// --- Date-only values never shift a day ------------------------------------
check("date-only formats the same day in Guyana", formatDealerDate("2026-01-01", "America/Guyana"), "Jan 1, 2026");
check("date-only formats the same day in Pacific/Kiritimati (+14)", formatDealerDate("2026-01-01", "Pacific/Kiritimati"), "Jan 1, 2026");
check("date-only formats the same day in Pacific/Niue (-11)", formatDealerDate("2026-01-01", "Pacific/Niue"), "Jan 1, 2026");
check("instant formats in dealer zone", formatDealerTime("2026-08-28T13:30:00Z", "America/Guyana"), "9:30 AM");
check("instant formats in NY", formatDealerTime("2026-08-28T13:30:00Z", "America/New_York"), "9:30 AM");
check("instant formats in Tokyo", formatDealerTime("2026-08-28T13:30:00Z", "Asia/Tokyo"), "10:30 PM");

// --- Business-day stepping preserves wall-clock time across DST -------------
// Friday 2026-03-06 10:00 EST + 1 business day lands Monday 2026-03-09 —
// AFTER the Mar 8 spring-forward — and must still read 10:00 local.
{
  const start = zonedTimeToUtc("America/New_York", 2026, 3, 6, 10, 0);
  const due = addBusinessDays(start, 1, "America/New_York");
  const p = zonedParts(due, "America/New_York");
  check("business day lands on Monday after DST", zonedDayKey(due, "America/New_York"), "2026-03-09");
  check("business-day due keeps 10:00 wall clock across spring-forward", `${p.hour}:${p.minute}`, "10:0");
}
{
  // Friday 2026-10-30 10:00 EDT + 2 business days crosses fall-back Nov 1.
  const start = zonedTimeToUtc("America/New_York", 2026, 10, 30, 10, 0);
  const due = addBusinessDays(start, 2, "America/New_York");
  const p = zonedParts(due, "America/New_York");
  check("business days skip the weekend across fall-back", zonedDayKey(due, "America/New_York"), "2026-11-03");
  check("business-day due keeps 10:00 wall clock across fall-back", `${p.hour}:${p.minute}`, "10:0");
}
{
  // No transition: plain Guyana stepping stays exact.
  const start = zonedTimeToUtc("America/Guyana", 2026, 8, 28, 15, 30); // Friday
  const due = addBusinessDays(start, 3, "America/Guyana");
  check("Guyana +3 business days from Friday is Wednesday", zonedDayKey(due, "America/Guyana"), "2026-09-02");
  check("Guyana stepping keeps wall clock", zonedParts(due, "America/Guyana").hour, 15);
}

// --- Dealer-local "today"/reference-year derivations -------------------------
// 2027-01-01 01:00Z: Tokyo is already in 2027; Guyana is still Dec 31, 2026.
{
  const newYear = new Date("2027-01-01T01:00:00Z");
  check("reference year in Tokyo at 01:00Z Jan 1", zonedParts(newYear, "Asia/Tokyo").year, 2027);
  check("reference year in Guyana at 01:00Z Jan 1", zonedParts(newYear, "America/Guyana").year, 2026);
  check("today key in Guyana at 01:00Z Jan 1", zonedDayKey(newYear, "America/Guyana"), "2026-12-31");
  // Default report ranges derive from the dealer-local day key.
  check("30-days-ago key from Guyana New Year's Eve", zonedAddDays(newYear, "America/Guyana", -30), "2026-12-01");
}

// --- Static audit: no browser-local date rendering in the AURA client -------
// Every user-facing date must go through the dealer-timezone helpers in the
// client format lib. date-fns `format()` (and raw toLocale* without an
// explicit timeZone) renders in the BROWSER zone, so its use for absolute
// dates is banned. formatDistanceToNow (relative time) is timezone-free.
{
  const auraSrc = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../aura/src",
  );
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(entry)) {
        const src = readFileSync(p, "utf8");
        if (/import\s*{[^}]*\bformat\b[^}]*}\s*from\s*"date-fns"/.test(src)) {
          offenders.push(p);
        }
      }
    }
  };
  walk(auraSrc);
  check(
    "no browser-local date-fns format() imports in AURA client",
    offenders.join(", "),
    "",
  );
}

// --- Identifier validation ---------------------------------------------------
check("valid IANA id accepted", isValidTimezone("America/New_York"), true);
check("invalid id rejected", isValidTimezone("Not/AZone"), false);
check("empty id rejected", isValidTimezone(""), false);

if (failures > 0) {
  console.error(`\n${failures} timezone check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll timezone boundary checks passed.");
