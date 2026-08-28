import { Router, type IRouter } from "express";
import { and, eq, gt, gte, isNotNull, lt, lte, ne, sql } from "drizzle-orm";
import {
  db,
  leadsTable,
  vehiclesTable,
  timelineEventsTable,
  testDrivesTable,
  type Lead,
} from "@workspace/db";
import {
  GetTestDriveInviteParams,
  GetTestDriveInviteResponse,
  BookTestDriveSlotParams,
  BookTestDriveSlotBody,
  BookTestDriveSlotResponse,
} from "@workspace/api-zod";
import { enqueueEmail, notifyUser, notifyUsers } from "../lib/email";
import { ensureAccountForLead } from "../lib/accounts";
import { dealerStaffIdsByRole } from "../lib/tenancy";
import {
  ownerCalendarContact,
  testDriveCalendarFields,
} from "../lib/calendar";
import {
  afterTestDriveBooked,
  daySlotTimes,
  SLOT_LENGTH_MS,
  vehicleAvailabilityError,
} from "../lib/test-drive-scheduler";
import {
  capacityBlockedDays,
  isSlotBlocked,
  modelUnitIds,
  type BlockedDays,
} from "../lib/capacity-blocks";
import {
  dealerTimezone,
  formatDealerSlot,
  formatDealerTime,
  zonedAddDays,
  zonedDayKey,
  zonedStartOfDay,
} from "../lib/timezone";

// ---------------------------------------------------------------------------
// PUBLIC self-service test-drive booking — reached from the unique link
// emailed to a lead ("test_drive_invite"). Mounted BEFORE requireAuth.
// The showroom runs one drive at a time: a slot taken by ANY lead is blocked.
// ---------------------------------------------------------------------------

const router: IRouter = Router();

const WINDOW_DAYS = 14; // bookable window starts tomorrow; 30-minute slots

function windowDays(tz: string): Date[] {
  const now = new Date();
  return Array.from({ length: WINDOW_DAYS }, (_, i) =>
    zonedStartOfDay(zonedAddDays(now, tz, i + 1), tz),
  );
}

const timeLabel = (t: Date, tz: string) => formatDealerTime(t, tz);

/** Capacity-plan blocks for this lead's advisor + interested vehicle model. */
async function leadCapacityBlocks(lead: Lead): Promise<BlockedDays> {
  const vehicleIds = lead.interestedVehicleId
    ? await modelUnitIds(lead.dealerId, lead.interestedVehicleId)
    : [];
  return capacityBlockedDays(lead.dealerId, {
    vehicleIds,
    advisorUserId: lead.ownerUserId,
  });
}

const fullLabel = (t: Date, tz: string) => formatDealerSlot(t, tz);

async function findLeadByToken(token: string): Promise<Lead | null> {
  const [lead] = await db
    .select()
    .from(leadsTable)
    .where(eq(leadsTable.testDriveToken, token));
  return lead ?? null;
}

async function takenSlotTimes(
  dealerId: number,
  excludeLeadId: number,
  tz: string,
): Promise<Set<number>> {
  const days = windowDays(tz);
  const start = days[0]!;
  const end = new Date(
    zonedStartOfDay(zonedAddDays(days[days.length - 1]!, tz, 1), tz).getTime() - 1,
  );
  const rows = await db
    .select({ at: leadsTable.testDriveAt })
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.dealerId, dealerId),
        isNotNull(leadsTable.testDriveAt),
        ne(leadsTable.id, excludeLeadId),
        gte(leadsTable.testDriveAt, start),
        lte(leadsTable.testDriveAt, end),
      ),
    );
  // A booking blocks every grid slot within ±30 minutes (exclusive), matching
  // the conflict window enforced at claim time — legacy off-grid bookings
  // therefore grey out both slots they overlap instead of showing as free.
  const taken = new Set<number>();
  for (const r of rows) {
    const at = r.at!.getTime();
    for (const day of days) {
      for (const t of daySlotTimes(day, tz)) {
        const ms = t.getTime();
        if (Math.abs(ms - at) < SLOT_LENGTH_MS) taken.add(ms);
      }
    }
  }
  return taken;
}

async function buildInvite(lead: Lead) {
  const tz = await dealerTimezone(lead.dealerId);
  const [v] = lead.interestedVehicleId
    ? await db
        .select()
        .from(vehiclesTable)
        .where(
          and(
            eq(vehiclesTable.id, lead.interestedVehicleId),
            eq(vehiclesTable.dealerId, lead.dealerId),
          ),
        )
    : [];
  const taken = await takenSlotTimes(lead.dealerId, lead.id, tz);
  // Advisor/vehicle capacity blocks hide those slots from the customer.
  const blocked = await leadCapacityBlocks(lead);

  const days = windowDays(tz).map((day) => ({
    date: zonedDayKey(day, tz),
    label: day.toLocaleDateString("en-US", {
      timeZone: tz,
      weekday: "short",
      month: "short",
      day: "numeric",
    }),
    slots: daySlotTimes(day, tz).map((t) => ({
      iso: t.toISOString(),
      label: timeLabel(t, tz),
      available: !taken.has(t.getTime()) && !isSlotBlocked(blocked, t, tz),
    })),
  }));

  return {
    leadName: lead.name,
    vehicle: v ? `${v.year} ${v.make} ${v.model}` : null,
    vehicleImageUrl: v?.imageUrl ?? null,
    branch: lead.testDriveBranch ?? lead.preferredBranch ?? null,
    bookedAt: lead.testDriveAt ? lead.testDriveAt.toISOString() : null,
    bookedLabel: lead.testDriveAt ? fullLabel(lead.testDriveAt, tz) : null,
    days,
  };
}

router.get("/test-drive/:token", async (req, res): Promise<void> => {
  const params = GetTestDriveInviteParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const lead = await findLeadByToken(params.data.token);
  if (!lead) {
    res.status(404).json({ error: "This booking link is not valid" });
    return;
  }
  if (lead.status === "lost" || lead.status === "converted") {
    res.status(410).json({
      error: "This booking link has expired — contact the showroom to book.",
    });
    return;
  }
  res.json(GetTestDriveInviteResponse.parse(await buildInvite(lead)));
});

router.post("/test-drive/:token/book", async (req, res): Promise<void> => {
  const params = BookTestDriveSlotParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = BookTestDriveSlotBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const lead = await findLeadByToken(params.data.token);
  if (!lead) {
    res.status(404).json({ error: "This booking link is not valid" });
    return;
  }
  if (lead.status === "lost" || lead.status === "converted") {
    res.status(410).json({
      error: "This booking link has expired — contact the showroom to book.",
    });
    return;
  }

  const when = new Date(body.data.slot);
  const tz = await dealerTimezone(lead.dealerId);
  if (Number.isNaN(when.getTime())) {
    res.status(422).json({ error: "Invalid slot time" });
    return;
  }

  if (!body.data.waiverAccepted) {
    res.status(422).json({
      error: "Please accept the test-drive waiver to confirm your booking",
    });
    return;
  }

  // The slot must be one the showroom actually offers (tomorrow → +14 days,
  // on the half-hour between opening hours).
  const offered = new Set(
    windowDays(tz).flatMap((day) =>
      daySlotTimes(day, tz).map((t) => t.getTime()),
    ),
  );
  if (!offered.has(when.getTime())) {
    res
      .status(422)
      .json({ error: "That time is outside the bookable window" });
    return;
  }

  // A10 — the vehicle itself must still be available for a drive.
  const vehicleError = await vehicleAvailabilityError(lead);
  if (vehicleError) {
    res.status(409).json({ error: vehicleError });
    return;
  }

  // Atomic slot claim: a per-dealer advisory lock serialises concurrent
  // bookings, and conflict + capacity are re-checked inside the transaction
  // so two simultaneous requests can never both take the same slot.
  let claimError: string | null = null;
  const updated = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(42001, ${lead.dealerId})`,
    );
    const lo = new Date(when.getTime() - SLOT_LENGTH_MS);
    const hi = new Date(when.getTime() + SLOT_LENGTH_MS);
    const [conflict] = await tx
      .select({ id: leadsTable.id })
      .from(leadsTable)
      .where(
        and(
          eq(leadsTable.dealerId, lead.dealerId),
          isNotNull(leadsTable.testDriveAt),
          gt(leadsTable.testDriveAt, lo),
          lt(leadsTable.testDriveAt, hi),
          ne(leadsTable.id, lead.id),
        ),
      );
    if (conflict) {
      claimError = "That time was just taken — please pick another slot";
      return null;
    }
    // Advisor/vehicle capacity blocks apply to self-service bookings too.
    if (isSlotBlocked(await leadCapacityBlocks(lead), when, tz)) {
      claimError =
        "That time is unavailable (your advisor or the vehicle is booked out) — please pick another slot";
      return null;
    }
    const [row] = await tx
      .update(leadsTable)
      .set({
        testDriveAt: when,
        testDriveBranch:
          lead.testDriveBranch ?? lead.preferredBranch ?? "Main Showroom",
        testDriveLicence: body.data.licenceNumber,
        testDriveWaiver: true,
        status: "test_drive",
        phase:
          lead.phase === "new" || lead.phase === "contacted"
            ? "qualified"
            : lead.phase,
        ...(lead.phase === "new" || lead.phase === "contacted"
          ? { stageEnteredAt: new Date() }
          : {}),
      })
      .where(
        and(eq(leadsTable.id, lead.id), eq(leadsTable.dealerId, lead.dealerId)),
      )
      .returning();
    return row ?? null;
  });
  if (!updated) {
    res.status(409).json({
      error: claimError ?? "That time is unavailable — please pick another slot",
    });
    return;
  }

  // A booked test drive promotes the lead to an account.
  updated!.customerId = await ensureAccountForLead(updated!);

  // First-class record: supersede any prior scheduled drive, insert the new one.
  await db
    .update(testDrivesTable)
    .set({ status: "cancelled", cancelledAt: new Date() })
    .where(
      and(
        eq(testDrivesTable.dealerId, updated!.dealerId),
        eq(testDrivesTable.leadId, updated!.id),
        eq(testDrivesTable.status, "scheduled"),
      ),
    );
  await db.insert(testDrivesTable).values({
    dealerId: updated!.dealerId,
    leadId: updated!.id,
    vehicleId: updated!.interestedVehicleId ?? null,
    customerId: updated!.customerId ?? null,
    status: "scheduled",
    scheduledAt: when,
    branch: updated!.testDriveBranch,
    licenceNumber: updated!.testDriveLicence,
    waiverAccepted: true,
    bookedVia: "self_service",
  });

  const [v] = updated!.interestedVehicleId
    ? await db
        .select()
        .from(vehiclesTable)
        .where(
          and(
            eq(vehiclesTable.id, updated!.interestedVehicleId),
            eq(vehiclesTable.dealerId, updated!.dealerId),
          ),
        )
    : [];
  const vehicle = v ? `${v.year} ${v.make} ${v.model}` : null;
  const dateStr = formatDealerSlot(when, tz).split(" at ")[0]!;
  const timeStr = timeLabel(when, tz);
  const rescheduled = Boolean(lead.testDriveAt);

  await db.insert(timelineEventsTable).values({
    dealerId: updated!.dealerId,
    customerId: updated!.customerId,
    domain: "leads",
    kind: "test_drive_scheduled",
    title: rescheduled
      ? `Test drive rescheduled to ${dateStr}`
      : `Test drive booked for ${dateStr}`,
    detail: `${vehicle ?? "Vehicle"} at ${timeStr}${updated!.testDriveBranch ? ` — ${updated!.testDriveBranch} branch` : ""}. Booked by the customer via their invite link.`,
    actor: updated!.name,
    isAgent: false,
    refType: "lead",
    refId: updated!.id,
  });

  // Calendar invite lands on both the customer's and the owner's calendar.
  const owner = await ownerCalendarContact(updated!.ownerUserId);
  const calendarFields = testDriveCalendarFields(updated!, vehicle, owner);

  if (updated!.email) {
    await enqueueEmail({
      dealerId: updated!.dealerId,
      template: "test_drive_confirmation",
      to: updated!.email,
      customerId: updated!.customerId,
      data: {
        vehicle: vehicle ?? "",
        date: dateStr,
        time: timeStr,
        ...calendarFields,
      },
    });
  }

  if (owner) {
    await enqueueEmail({
      dealerId: updated!.dealerId,
      template: "test_drive_owner_invite",
      to: owner.email,
      customerId: updated!.customerId,
      data: {
        leadName: updated!.name,
        vehicle: vehicle ?? "",
        date: dateStr,
        time: timeStr,
        branch: updated!.testDriveBranch ?? "Main Showroom",
        ...calendarFields,
      },
    });
  }

  try {
    if (updated!.ownerUserId) {
      await notifyUser({
        userId: updated!.ownerUserId,
        dealerId: updated!.dealerId,
        type: "task",
        title: `Test drive: ${updated!.name} — ${dateStr}`,
        body: `${vehicle ?? "Vehicle"} at ${timeStr}, self-booked by the customer. Have it detailed and ready.`,
        link: "/pipeline",
      });
    } else {
      const coordinators = await dealerStaffIdsByRole(updated!.dealerId, [
        "Marketing Coordinator",
        "Sales Manager",
        "General Manager",
      ]);
      await notifyUsers(
        coordinators,
        {
          dealerId: updated!.dealerId,
          type: "task",
          title: `Test drive: ${updated!.name} — ${dateStr}`,
          body: `${vehicle ?? "Vehicle"} at ${timeStr}, self-booked by the customer via their invite link.`,
          link: "/pipeline",
        },
      );
    }
  } catch (err) {
    req.log.error({ err }, "Failed to notify staff of self-booked test drive");
  }

  // A10 — soft-lock single-unit models + queue the 24h WhatsApp reminder.
  await afterTestDriveBooked(updated!, when, vehicle);

  res.json(BookTestDriveSlotResponse.parse(await buildInvite(updated!)));
});

export default router;
