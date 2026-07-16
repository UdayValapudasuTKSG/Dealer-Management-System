import { Router, type IRouter } from "express";
import { and, eq, gte, isNotNull, lte, ne, sql } from "drizzle-orm";
import {
  db,
  leadsTable,
  vehiclesTable,
  usersTable,
  rolesTable,
  timelineEventsTable,
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

async function takenSlotTimes(excludeLeadId: number): Promise<Set<number>> {
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
        .where(eq(vehiclesTable.id, lead.interestedVehicleId))
    : [];
  const taken = await takenSlotTimes(lead.id);

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

  const taken = await takenSlotTimes(lead.id);
  if (taken.has(when.getTime())) {
    res
      .status(409)
      .json({ error: "That time was just taken — please pick another slot" });
    return;
  }

  const [updated] = await db
    .update(leadsTable)
    .set({
      testDriveAt: when,
      testDriveBranch:
        lead.testDriveBranch ?? lead.preferredBranch ?? "Main Showroom",
      status: "test_drive",
      phase:
        lead.phase === "aware" || lead.phase === "consider"
          ? "engage"
          : lead.phase,
    })
    .where(eq(leadsTable.id, lead.id))
    .returning();

  // A booked test drive promotes the lead to an account.
  updated!.customerId = await ensureAccountForLead(updated!);

  const [v] = updated!.interestedVehicleId
    ? await db
        .select()
        .from(vehiclesTable)
        .where(eq(vehiclesTable.id, updated!.interestedVehicleId))
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

  if (updated!.email) {
    await enqueueEmail({
      template: "test_drive_confirmation",
      to: updated!.email,
      customerId: updated!.customerId,
      data: { vehicle: vehicle ?? "", date: dateStr, time: timeStr },
    });
  }

  try {
    if (updated!.ownerUserId) {
      await notifyUser({
        userId: updated!.ownerUserId,
        type: "task",
        title: `Test drive: ${updated!.name} — ${dateStr}`,
        body: `${vehicle ?? "Vehicle"} at ${timeStr}, self-booked by the customer. Have it detailed and ready.`,
        link: "/pipeline",
      });
    } else {
      const coordinators = await db
        .select({ id: usersTable.id })
        .from(usersTable)
        .leftJoin(rolesTable, eq(usersTable.roleId, rolesTable.id))
        .where(
          sql`${rolesTable.name} in ('Marketing Coordinator', 'Sales Manager', 'General Manager') and ${usersTable.status} = 'active'`,
        );
      await notifyUsers(
        coordinators.map((c) => c.id),
        {
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

  res.json(BookTestDriveSlotResponse.parse(await buildInvite(updated!)));
});

export default router;
