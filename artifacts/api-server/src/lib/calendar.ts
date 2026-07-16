import { eq } from "drizzle-orm";
import { db, usersTable, type Lead } from "@workspace/db";

// ---------------------------------------------------------------------------
// iCalendar (RFC 5545) invites for test drives.
//
// When a drive is booked we attach a METHOD:REQUEST invite to both the
// customer's confirmation email and a dedicated email to the lead owner —
// Gmail/Outlook/Apple Calendar add these to the calendar automatically.
// The UID is stable per lead and SEQUENCE increases on every (re)booking,
// so a reschedule UPDATES the existing calendar event instead of piling up
// duplicates.
//
// All inputs are strings because they ride inside the email-queue jsonb
// payload (the invite is rebuilt identically on every send attempt).
// ---------------------------------------------------------------------------

const DEFAULT_DURATION_MINS = 60;

function icsUtc(dt: Date): string {
  return dt
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

function esc(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** Fold lines longer than 75 octets per RFC 5545 §3.1. */
function fold(line: string): string {
  if (line.length <= 73) return line;
  const parts: string[] = [];
  let rest = line;
  while (rest.length > 73) {
    parts.push(rest.slice(0, 73));
    rest = " " + rest.slice(73);
  }
  parts.push(rest);
  return parts.join("\r\n");
}

/**
 * Payload fields the email queue needs to rebuild the invite at send time.
 * Attach these to test_drive_confirmation / test_drive_owner_invite emails.
 */
export function testDriveCalendarFields(
  lead: Lead,
  vehicle: string | null,
  owner: { email: string; name: string } | null,
): Record<string, string> {
  if (!lead.testDriveAt) return {};
  return {
    startsAtIso: lead.testDriveAt.toISOString(),
    durationMins: String(DEFAULT_DURATION_MINS),
    leadId: String(lead.id),
    leadName: lead.name,
    branch: lead.testDriveBranch ?? "Main Showroom",
    ...(vehicle ? { vehicle } : {}),
    ...(lead.email ? { customerEmail: lead.email } : {}),
    ...(owner ? { ownerEmail: owner.email, ownerName: owner.name } : {}),
    // Monotonic sequence — reschedules bump it so calendars replace the event.
    calSequence: String(Math.floor(Date.now() / 1000)),
  };
}

/** Look up the lead owner's email/name for calendar attendance. */
export async function ownerCalendarContact(
  ownerUserId: number | null | undefined,
): Promise<{ email: string; name: string } | null> {
  if (!ownerUserId) return null;
  const [u] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, ownerUserId));
  if (!u?.email) return null;
  return { email: u.email, name: u.name || "AURA Advisor" };
}

/**
 * Build the .ics content from an email-queue payload. Returns null when the
 * payload has no (valid) calendar fields, so callers can skip the attachment.
 */
export function testDriveIcsFromPayload(
  payload: Record<string, string>,
): string | null {
  const startsAtIso = payload.startsAtIso;
  if (!startsAtIso) return null;
  const start = new Date(startsAtIso);
  if (Number.isNaN(start.getTime())) return null;

  const durationMins =
    Number.parseInt(payload.durationMins ?? "", 10) || DEFAULT_DURATION_MINS;
  const end = new Date(start.getTime() + durationMins * 60_000);
  const organizerEmail = process.env.GMAIL_USER;
  if (!organizerEmail) return null;

  const attendees: { name: string; email: string }[] = [];
  if (payload.customerEmail) {
    attendees.push({
      name: payload.leadName || "Customer",
      email: payload.customerEmail,
    });
  }
  if (payload.ownerEmail) {
    attendees.push({
      name: payload.ownerName || "AURA Advisor",
      email: payload.ownerEmail,
    });
  }

  const vehicle = payload.vehicle || "your selected vehicle";
  const branch = payload.branch || "Main Showroom";
  const summary = `Test Drive — ${vehicle}`;
  const description = `Test drive of the ${vehicle} with ${payload.leadName || "the customer"}. Hosted by AURA Dealership, ${branch} branch. The vehicle will be detailed and ready at the showroom entrance.`;
  const sequence = Number.parseInt(payload.calSequence ?? "", 10) || 0;

  const lines = [
    "BEGIN:VCALENDAR",
    "PRODID:-//AURA Dealership OS//Test Drive//EN",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:aura-test-drive-lead-${payload.leadId || "0"}@aura-dealership`,
    `DTSTAMP:${icsUtc(new Date())}`,
    `DTSTART:${icsUtc(start)}`,
    `DTEND:${icsUtc(end)}`,
    `SEQUENCE:${sequence}`,
    "STATUS:CONFIRMED",
    `SUMMARY:${esc(summary)}`,
    `DESCRIPTION:${esc(description)}`,
    `LOCATION:${esc(`AURA Dealership — ${branch} branch`)}`,
    `ORGANIZER;CN=AURA Dealership:mailto:${organizerEmail}`,
    ...attendees.map(
      (a) =>
        `ATTENDEE;CN=${esc(a.name)};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${a.email}`,
    ),
    "BEGIN:VALARM",
    "TRIGGER:-PT60M",
    "ACTION:DISPLAY",
    "DESCRIPTION:Test drive in one hour",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n");
}
