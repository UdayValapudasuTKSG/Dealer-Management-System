import { and, eq, ne } from "drizzle-orm";
import {
  db,
  emailLogsTable,
  leadsTable,
  vehiclesTable,
  type Lead,
} from "@workspace/db";
import { enqueueWhatsapp } from "./email";
import { testDriveBookingUrl } from "./email-triggers";
import { logger } from "./logger";
import {
  dealerTimezone,
  formatDealerSlot,
  zonedAddDays,
  zonedParts,
  zonedStartOfDay,
  zonedTimeToUtc,
} from "./timezone";

// ---------------------------------------------------------------------------
// A10 — Test Drive Scheduler helpers.
// After every test-drive booking (staff or self-service):
//   1. Soft-lock the vehicle when it is the ONLY available unit of its model
//      (holdUntil = drive time + 2h) so it isn't sold out from under the drive.
//   2. Queue a WhatsApp reminder 24h before the drive asking Yes/No; a "No"
//      reply gets the reschedule link (handled in whatsapp-flow).
// ---------------------------------------------------------------------------

const HOLD_AFTER_DRIVE_MS = 2 * 60 * 60 * 1000;
const REMINDER_LEAD_MS = 24 * 60 * 60 * 1000;

// Showroom slot grid — shared with the public booking page and the staff
// A10 availability check so both always agree on what's offerable.
export const SLOT_OPEN_HOUR = 9; // first slot 9:00 AM
export const SLOT_LAST_HOUR = 16; // last slot starts 4:30 PM
export const SLOT_WINDOW_DAYS = 14; // bookable window starts tomorrow
export const SLOT_LENGTH_MS = 30 * 60 * 1000; // 30-minute drives

export function slotWindowDays(tz: string): Date[] {
  const now = new Date();
  return Array.from({ length: SLOT_WINDOW_DAYS }, (_, i) =>
    zonedStartOfDay(zonedAddDays(now, tz, i + 1), tz),
  );
}

export function offeredSlotTimes(tz: string): Date[] {
  return slotWindowDays(tz).flatMap((day) => daySlotTimes(day, tz));
}

/** True when a time sits on the shared 30-minute booking grid. */
export function slotGridAligned(d: Date, tz: string): boolean {
  const p = zonedParts(d, tz);
  return (
    p.minute % 30 === 0 &&
    p.second === 0 &&
    d.getMilliseconds() === 0
  );
}

/** 30-minute slot start times for one day: 9:00, 9:30, … 4:30 PM. */
export function daySlotTimes(day: Date, tz: string): Date[] {
  const p = zonedParts(day, tz);
  const halfHours = (SLOT_LAST_HOUR - SLOT_OPEN_HOUR + 1) * 2;
  return Array.from(
    { length: halfHours },
    (_, i) =>
      zonedTimeToUtc(
        tz,
        p.year,
        p.month,
        p.day,
        SLOT_OPEN_HOUR + Math.floor(i / 2),
        (i % 2) * 30,
      ),
  );
}

/**
 * Availability gate: the lead's interested vehicle must still be in a
 * test-drivable status. Returns an error message when it is not.
 */
export async function vehicleAvailabilityError(
  lead: Lead,
): Promise<string | null> {
  if (!lead.interestedVehicleId) return null;
  const [v] = await db
    .select()
    .from(vehiclesTable)
    .where(
      and(
        eq(vehiclesTable.id, lead.interestedVehicleId),
        eq(vehiclesTable.dealerId, lead.dealerId),
      ),
    );
  if (!v) return null;
  if (["sold", "delivered", "in_transit"].includes(v.status)) {
    return `The ${v.year} ${v.make} ${v.model} is no longer available for a test drive (status: ${v.status.replace(/_/g, " ")}).`;
  }
  return null;
}

/** Soft-lock the interested vehicle if it's the sole available unit of its model. */
async function softLockSingleUnit(lead: Lead, when: Date): Promise<void> {
  if (!lead.interestedVehicleId) return;
  const [v] = await db
    .select()
    .from(vehiclesTable)
    .where(
      and(
        eq(vehiclesTable.id, lead.interestedVehicleId),
        eq(vehiclesTable.dealerId, lead.dealerId),
      ),
    );
  if (!v || v.status !== "available") return;

  const siblings = await db
    .select({ id: vehiclesTable.id })
    .from(vehiclesTable)
    .where(
      and(
        eq(vehiclesTable.dealerId, lead.dealerId),
        eq(vehiclesTable.make, v.make),
        eq(vehiclesTable.model, v.model),
        eq(vehiclesTable.status, "available"),
        ne(vehiclesTable.id, v.id),
      ),
    );
  if (siblings.length > 0) return; // other units exist — no lock needed

  await db
    .update(vehiclesTable)
    .set({
      holdUntil: new Date(when.getTime() + HOLD_AFTER_DRIVE_MS),
      holdReason: `Held for ${lead.name}'s test drive — only unit of this model in stock`,
    })
    .where(eq(vehiclesTable.id, v.id));
  logger.info(
    { vehicleId: v.id, leadId: lead.id },
    "single-unit model soft-locked for test drive",
  );
}

/** Queue the 24h-before WhatsApp reminder (idempotent per lead+slot).
 * Any still-queued reminder for a DIFFERENT slot is superseded first, so a
 * reschedule never leaves the customer with two conflicting reminders. */
async function queueReminder(lead: Lead, when: Date, vehicle: string | null) {
  const phone = (lead.phone ?? "").replace(/\D/g, "");
  if (!phone) return;
  await db
    .update(emailLogsTable)
    .set({ status: "cancelled" })
    .where(
      and(
        eq(emailLogsTable.dealerId, lead.dealerId),
        eq(emailLogsTable.leadId, lead.id),
        eq(emailLogsTable.template, "test_drive_reminder"),
        eq(emailLogsTable.status, "queued"),
        ne(emailLogsTable.dedupeKey, `tdrem:${lead.id}:${when.getTime()}`),
      ),
    );
  const sendAt = new Date(when.getTime() - REMINDER_LEAD_MS);
  if (sendAt.getTime() <= Date.now()) return; // drive is under 24h away
  const tz = await dealerTimezone(lead.dealerId);
  const timeLabel = formatDealerSlot(when, tz);
  const body =
    `Hi ${lead.name.split(" ")[0]}! Friendly reminder from AURA: your test drive` +
    `${vehicle ? ` of the ${vehicle}` : ""} is tomorrow — ${timeLabel}. ` +
    `Reply YES to confirm, or NO if you need to reschedule.`;
  await enqueueWhatsapp({
    kind: "test_drive_reminder",
    to: phone,
    body,
    dealerId: lead.dealerId,
    leadId: lead.id,
    customerId: lead.customerId,
    summary: `Test-drive reminder — ${lead.name}, ${timeLabel}`,
    dedupeKey: `tdrem:${lead.id}:${when.getTime()}`,
    sendAt,
  });
}

/** Run all post-booking scheduler steps. Never throws — booking must succeed. */
export async function afterTestDriveBooked(
  lead: Lead,
  when: Date,
  vehicle: string | null,
): Promise<void> {
  try {
    await softLockSingleUnit(lead, when);
  } catch (err) {
    logger.error({ err, leadId: lead.id }, "test-drive soft-lock failed");
  }
  try {
    await queueReminder(lead, when, vehicle);
  } catch (err) {
    logger.error({ err, leadId: lead.id }, "test-drive reminder enqueue failed");
  }
}

/** The reschedule link sent when a customer replies "No" to the reminder. */
export function rescheduleLink(lead: Lead): string | null {
  return lead.testDriveToken ? testDriveBookingUrl(lead.testDriveToken) : null;
}
