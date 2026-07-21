import { Router, type IRouter } from "express";
import { and, eq, gte, inArray, isNotNull, lte, ne } from "drizzle-orm";
import {
  db,
  leadsTable,
  deliveriesTable,
  serviceOrdersTable,
  tasksTable,
  usersTable,
  vehiclesTable,
} from "@workspace/db";
import { GetCalendarResponse } from "@workspace/api-zod";
import { activeDealerId } from "../middlewares/rbac";

// ---------------------------------------------------------------------------
// Dealership calendar — a DERIVED view over existing scheduling data:
// test drives (leads), delivery appointments, service orders, and task due
// dates. Sales Advisors see only their own items; managers see everything.
// ---------------------------------------------------------------------------

const router: IRouter = Router();

type CalendarEvent = {
  id: string;
  kind: "test_drive" | "delivery" | "service" | "follow_up";
  title: string;
  detail: string | null;
  startsAt: Date;
  allDay: boolean;
  assigneeName: string | null;
  link: string | null;
  refId?: number;
};

/** date-string columns ("YYYY-MM-DD") → local midnight, avoiding the UTC shift. */
function localDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1);
}

router.get("/calendar", async (req, res): Promise<void> => {
  const from = new Date(String(req.query["from"] ?? ""));
  const to = new Date(String(req.query["to"] ?? ""));
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    res.status(400).json({ error: "from and to must be valid dates" });
    return;
  }

  const dealerId = activeDealerId(res);
  const user = res.locals.user;
  const ownOnly = Boolean(user && user.roleName === "Sales Advisor");
  const scope = ownOnly ? "own" : "all";

  const nameById = new Map<number, string>(
    (
      await db
        .select({ id: usersTable.id, name: usersTable.name })
        .from(usersTable)
    ).map((u) => [u.id, u.name ?? `User #${u.id}`]),
  );
  const events: CalendarEvent[] = [];

  // Test drives — leads.testDriveAt.
  const driveRows = await db
    .select()
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.dealerId, dealerId),
        isNotNull(leadsTable.testDriveAt),
        gte(leadsTable.testDriveAt, from),
        lte(leadsTable.testDriveAt, to),
        ...(ownOnly ? [eq(leadsTable.ownerUserId, user!.id)] : []),
      ),
    );
  const vehicleIds = driveRows
    .map((l) => l.interestedVehicleId)
    .filter((v): v is number => v != null);
  const vehicleById = new Map<number, string>(
    vehicleIds.length
      ? (
          await db
            .select()
            .from(vehiclesTable)
            .where(
              and(
                eq(vehiclesTable.dealerId, dealerId),
                inArray(vehiclesTable.id, vehicleIds),
              ),
            )
        ).map((v) => [v.id, `${v.year} ${v.make} ${v.model}`])
      : [],
  );
  for (const l of driveRows) {
    events.push({
      id: `td-${l.id}`,
      kind: "test_drive",
      title: `Test drive — ${l.name}`,
      detail:
        [
          l.interestedVehicleId
            ? vehicleById.get(l.interestedVehicleId)
            : null,
          l.testDriveBranch,
        ]
          .filter(Boolean)
          .join(" · ") || null,
      startsAt: l.testDriveAt!,
      allDay: false,
      assigneeName: l.ownerUserId ? (nameById.get(l.ownerUserId) ?? null) : null,
      link: `/lead/${l.id}`,
      refId: l.id,
    });
  }

  // Deliveries — appointmentAt.
  const deliveryRows = await db
    .select()
    .from(deliveriesTable)
    .where(
      and(
        eq(deliveriesTable.dealerId, dealerId),
        isNotNull(deliveriesTable.appointmentAt),
        gte(deliveriesTable.appointmentAt, from),
        lte(deliveriesTable.appointmentAt, to),
        ne(deliveriesTable.status, "cancelled"),
        ...(ownOnly ? [eq(deliveriesTable.advisorUserId, user!.id)] : []),
      ),
    );
  for (const d of deliveryRows) {
    events.push({
      id: `dl-${d.id}`,
      kind: "delivery",
      title: `Delivery — ${d.customerName ?? `Deal #${d.dealId}`}`,
      detail: d.status === "completed" ? "Completed" : "Handover appointment",
      startsAt: d.appointmentAt!,
      allDay: false,
      assigneeName: d.advisorUserId
        ? (nameById.get(d.advisorUserId) ?? null)
        : null,
      link: "/delivery",
      refId: d.id,
    });
  }

  // Service appointments — scheduledDate (date-only → all-day).
  const fromKey = from.toISOString().slice(0, 10);
  const toKey = to.toISOString().slice(0, 10);
  const serviceRows = await db
    .select()
    .from(serviceOrdersTable)
    .where(
      and(
        eq(serviceOrdersTable.dealerId, dealerId),
        gte(serviceOrdersTable.scheduledDate, fromKey),
        lte(serviceOrdersTable.scheduledDate, toKey),
        ...(ownOnly
          ? [eq(serviceOrdersTable.technicianUserId, user!.id)]
          : []),
      ),
    );
  for (const s of serviceRows) {
    events.push({
      id: `sv-${s.id}`,
      kind: "service",
      title: `Service — ${s.customerName ?? s.vehicleInfo}`,
      detail:
        [s.vehicleInfo, s.type.replace(/_/g, " ")].filter(Boolean).join(" · ") ||
        null,
      startsAt: localDate(s.scheduledDate),
      allDay: true,
      assigneeName: s.technicianUserId
        ? (nameById.get(s.technicianUserId) ?? s.technician)
        : s.technician,
      link: "/service",
      refId: s.id,
    });
  }

  // Follow-ups due — open tasks with a due date.
  const taskRows = await db
    .select()
    .from(tasksTable)
    .where(
      and(
        eq(tasksTable.dealerId, dealerId),
        isNotNull(tasksTable.dueDate),
        gte(tasksTable.dueDate, fromKey),
        lte(tasksTable.dueDate, toKey),
        ne(tasksTable.status, "done"),
        ...(ownOnly ? [eq(tasksTable.assigneeUserId, user!.id)] : []),
      ),
    );
  for (const t of taskRows) {
    events.push({
      id: `fu-${t.id}`,
      kind: "follow_up",
      title: t.title,
      detail: t.description,
      startsAt: localDate(t.dueDate!),
      allDay: true,
      assigneeName: t.assigneeUserId
        ? (nameById.get(t.assigneeUserId) ?? null)
        : null,
      link: t.leadId ? `/lead/${t.leadId}` : "/tasks",
      refId: t.id,
    });
  }

  events.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  res.json(GetCalendarResponse.parse({ events, scope }));
});

export default router;
