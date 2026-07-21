import { Router, type IRouter } from "express";
import { and, eq, gte, isNotNull, lte, ne } from "drizzle-orm";
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
  vehicleAvailabilityError,
} from "../lib/test-drive-scheduler";

// ---------------------------------------------------------------------------
// PUBLIC self-service test-drive booking — reached from the unique link
// emailed to a lead ("test_drive_invite"). Mounted BEFORE requireAuth.
// The showroom runs one drive at a time: a slot taken by ANY lead is blocked.
// ---------------------------------------------------------------------------

const router: IRouter = Router();

const OPEN_HOUR = 9; // first slot 9:00 AM
const LAST_HOUR = 16; // last slot 4:00 PM
const WINDOW_DAYS = 14; // bookable window starts tomorrow

function windowDays(): Date[] {
  const now = new Date();
  const days: Date[] = [];
  for (let offset = 1; offset <= WINDOW_DAYS; offset++) {
    days.push(new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset));
  }
  return days;
}

const timeLabel = (t: Date) =>
  t.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

const fullLabel = (t: Date) =>
  `${t.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  })} at ${timeLabel(t)}`;

const localDateKey = (day: Date) =>
  `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;

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
): Promise<Set<number>> {
  const days = windowDays();
  const start = days[0]!;
  const end = new Date(
    days[days.length - 1]!.getFullYear(),
    days[days.length - 1]!.getMonth(),
    days[days.length - 1]!.getDate(),
    23,
    59,
    59,
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
  return new Set(rows.map((r) => r.at!.getTime()));
}

async function buildInvite(lead: Lead) {
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
  const taken = await takenSlotTimes(lead.dealerId, lead.id);

  const days = windowDays().map((day) => ({
    date: localDateKey(day),
    label: day.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    }),
    slots: Array.from({ length: LAST_HOUR - OPEN_HOUR + 1 }, (_, i) => {
      const t = new Date(
        day.getFullYear(),
        day.getMonth(),
        day.getDate(),
        OPEN_HOUR + i,
      );
      return {
        iso: t.toISOString(),
        label: timeLabel(t),
        available: !taken.has(t.getTime()),
      };
    }),
  }));

  return {
    leadName: lead.name,
    vehicle: v ? `${v.year} ${v.make} ${v.model}` : null,
    vehicleImageUrl: v?.imageUrl ?? null,
    branch: lead.testDriveBranch ?? lead.preferredBranch ?? null,
    bookedAt: lead.testDriveAt ? lead.testDriveAt.toISOString() : null,
    bookedLabel: lead.testDriveAt ? fullLabel(lead.testDriveAt) : null,
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

  const when = new Date(body.data.slot);
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
  // on the hour between opening hours).
  const offered = new Set(
    windowDays().flatMap((day) =>
      Array.from({ length: LAST_HOUR - OPEN_HOUR + 1 }, (_, i) =>
        new Date(
          day.getFullYear(),
          day.getMonth(),
          day.getDate(),
          OPEN_HOUR + i,
        ).getTime(),
      ),
    ),
  );
  if (!offered.has(when.getTime())) {
    res
      .status(422)
      .json({ error: "That time is outside the bookable window" });
    return;
  }

  const taken = await takenSlotTimes(lead.dealerId, lead.id);
  if (taken.has(when.getTime())) {
    res
      .status(409)
      .json({ error: "That time was just taken — please pick another slot" });
    return;
  }

  // A10 — the vehicle itself must still be available for a drive.
  const vehicleError = await vehicleAvailabilityError(lead);
  if (vehicleError) {
    res.status(409).json({ error: vehicleError });
    return;
  }

  const [updated] = await db
    .update(leadsTable)
    .set({
      testDriveAt: when,
      testDriveBranch:
        lead.testDriveBranch ?? lead.preferredBranch ?? "Main Showroom",
      testDriveLicence: body.data.licenceNumber,
      testDriveWaiver: true,
      status: "test_drive",
      phase:
        lead.phase === "aware" || lead.phase === "consider"
          ? "engage"
          : lead.phase,
      ...(lead.phase === "aware" || lead.phase === "consider"
        ? { stageEnteredAt: new Date() }
        : {}),
    })
    .where(and(eq(leadsTable.id, lead.id), eq(leadsTable.dealerId, lead.dealerId)))
    .returning();

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
  const dateStr = when.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const timeStr = timeLabel(when);
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
