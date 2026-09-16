import { Router, type IRouter } from "express";
import { and, desc, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import {
  db,
  dealerUsersTable,
  jobCardsTable,
  rolesTable,
  serviceInvoicesTable,
  serviceOrdersTable,
  technicianDailyAvailabilityTable,
  technicianTimesheetEntriesTable,
  usersTable,
} from "@workspace/db";
import {
  CreateTechnicianTimesheetEntryBody,
  CreateTechnicianTimesheetEntryResponse,
  DeleteTechnicianTimesheetEntryParams,
  GetDailyTechnicianTimesheetQueryParams,
  GetDailyTechnicianTimesheetResponse,
  SetTechnicianDailyAvailabilityBody,
  SetTechnicianDailyAvailabilityParams,
  SetTechnicianDailyAvailabilityResponse,
  UpdateTechnicianTimesheetEntryBody,
  UpdateTechnicianTimesheetEntryParams,
  UpdateTechnicianTimesheetEntryResponse,
} from "@workspace/api-zod";
import {
  dealerTimezone,
  zonedStartOfDay,
  zonedTimeToUtc,
  zonedParts,
} from "../lib/timezone";
import { getServiceSettings } from "../lib/service-settings";
import {
  aggregateTechnicianMetrics,
  calculateTechnicianMetrics,
  roundHours,
} from "../lib/technician-timesheet-metrics";
import { activeDealerId } from "../middlewares/rbac";

const router: IRouter = Router();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDay(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isApprover(user: {
  roleName?: string | null;
  isSuperAdmin?: boolean;
} | null | undefined): boolean {
  if (!user) return false;
  if (user.isSuperAdmin) return true;
  return /service manager|general manager|leadership|management|owner.?admin|admin/i.test(
    user.roleName ?? "",
  );
}

function isTechnician(user: {
  roleName?: string | null;
  isSuperAdmin?: boolean;
} | null | undefined): boolean {
  return Boolean(user && !user.isSuperAdmin && /technician/i.test(user.roleName ?? ""));
}

function effectiveSoldHours(
  quotedLaborHours: number | null,
  laborHours: number,
): number {
  return Math.max(0, Number(quotedLaborHours ?? laborHours ?? 0));
}

type Tech = { id: number; name: string };

async function loadTechnicians(dealerId: number): Promise<Tech[]> {
  const rows = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
    })
    .from(usersTable)
    .innerJoin(dealerUsersTable, eq(dealerUsersTable.userId, usersTable.id))
    .innerJoin(rolesTable, eq(rolesTable.id, dealerUsersTable.roleId))
    .where(
      and(
        eq(dealerUsersTable.dealerId, dealerId),
        eq(rolesTable.name, "Technician"),
      ),
    )
    .orderBy(usersTable.id);
  return rows.map((row) => ({
    id: row.id,
    name: row.name ?? row.email ?? `User #${row.id}`,
  }));
}

function readError(error: unknown): string {
  return error instanceof Error ? error.message : "Invalid request";
}

async function assertTechnicianInDealer(
  dealerId: number,
  technicianUserId: number,
): Promise<Tech | null> {
  const [row] = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
    })
    .from(usersTable)
    .innerJoin(dealerUsersTable, eq(dealerUsersTable.userId, usersTable.id))
    .innerJoin(rolesTable, eq(rolesTable.id, dealerUsersTable.roleId))
    .where(
      and(
        eq(dealerUsersTable.dealerId, dealerId),
        eq(usersTable.id, technicianUserId),
        eq(rolesTable.name, "Technician"),
      ),
    );
  return row
    ? { id: row.id, name: row.name ?? row.email ?? `User #${row.id}` }
    : null;
}

async function validateDailyTotal(
  // Drizzle's transaction and root database types expose the same query
  // methods but are not structurally assignable because the root has a pool
  // client. Keep this narrow helper transaction-compatible.
  tx: any,
  dealerId: number,
  technicianUserId: number,
  workDate: string,
  nextMinutes: number,
  excludeId?: number,
): Promise<boolean> {
  // Serialise the daily-total check so two simultaneous manual entries cannot
  // push a technician over the 24-hour guard.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`${dealerId}:${technicianUserId}:${workDate}`})::bigint)`,
  );
  const [total] = await tx
    .select({
      minutes: sql<number>`coalesce(sum(${technicianTimesheetEntriesTable.durationMinutes}), 0)`,
    })
    .from(technicianTimesheetEntriesTable)
    .where(
      and(
        eq(technicianTimesheetEntriesTable.dealerId, dealerId),
        eq(technicianTimesheetEntriesTable.technicianUserId, technicianUserId),
        eq(technicianTimesheetEntriesTable.workDate, workDate),
        excludeId != null
          ? ne(technicianTimesheetEntriesTable.id, excludeId)
          : undefined,
      ),
    );
  return Number(total?.minutes ?? 0) + nextMinutes <= 24 * 60;
}

type EntryWithJob = {
  id: number;
  technicianUserId: number;
  workDate: string;
  jobCardId: number | null;
  durationMinutes: number;
  note: string | null;
  source: string;
  createdAt: Date;
  updatedAt: Date;
  jobCardTitle: string | null;
  customerName: string | null;
};

function entryPayload(row: EntryWithJob) {
  return {
    id: row.id,
    technicianUserId: row.technicianUserId,
    workDate: row.workDate,
    jobCardId: row.jobCardId,
    jobCardTitle: row.jobCardTitle,
    customerName: row.customerName,
    durationMinutes: row.durationMinutes,
    note: row.note,
    source: "manual" as const,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function loadEntry(
  dealerId: number,
  id: number,
): Promise<EntryWithJob | null> {
  const [row] = await db
    .select({
      id: technicianTimesheetEntriesTable.id,
      technicianUserId: technicianTimesheetEntriesTable.technicianUserId,
      workDate: technicianTimesheetEntriesTable.workDate,
      jobCardId: technicianTimesheetEntriesTable.jobCardId,
      durationMinutes: technicianTimesheetEntriesTable.durationMinutes,
      note: technicianTimesheetEntriesTable.note,
      source: technicianTimesheetEntriesTable.source,
      createdAt: technicianTimesheetEntriesTable.createdAt,
      updatedAt: technicianTimesheetEntriesTable.updatedAt,
      jobCardTitle: jobCardsTable.title,
      customerName: serviceOrdersTable.customerName,
    })
    .from(technicianTimesheetEntriesTable)
    .leftJoin(
      jobCardsTable,
      and(
        eq(jobCardsTable.id, technicianTimesheetEntriesTable.jobCardId),
        eq(jobCardsTable.dealerId, technicianTimesheetEntriesTable.dealerId),
      ),
    )
    .leftJoin(
      serviceOrdersTable,
      and(
        eq(serviceOrdersTable.id, jobCardsTable.serviceOrderId),
        eq(serviceOrdersTable.dealerId, technicianTimesheetEntriesTable.dealerId),
      ),
    )
    .where(
      and(
        eq(technicianTimesheetEntriesTable.dealerId, dealerId),
        eq(technicianTimesheetEntriesTable.id, id),
      ),
    );
  return row ?? null;
}

router.get("/service-timesheets", async (req, res): Promise<void> => {
  const parsed = GetDailyTechnicianTimesheetQueryParams.safeParse(req.query);
  if (!parsed.success || !isValidDay(parsed.data?.date ?? "")) {
    res.status(400).json({ error: "date must be a valid dealer-local YYYY-MM-DD" });
    return;
  }
  const dealerId = activeDealerId(res);
  const viewer = res.locals.user;
  if (!isTechnician(viewer) && !isApprover(viewer)) {
    res.status(403).json({ error: "Only technicians or service managers may view timesheets" });
    return;
  }
  const requestedTech = parsed.data.technicianUserId;
  if (isTechnician(viewer) && requestedTech != null && requestedTech !== viewer!.id) {
    res.status(403).json({ error: "Technicians may only view their own timesheet" });
    return;
  }
  const targetTechId = isTechnician(viewer) ? viewer!.id : requestedTech;
  if (targetTechId != null && !(await assertTechnicianInDealer(dealerId, targetTechId))) {
    res.status(404).json({ error: "Technician not found in this dealership" });
    return;
  }
  const date = parsed.data.date;
  const tz = await dealerTimezone(dealerId);
  const start = zonedStartOfDay(date, tz);
  const parts = zonedParts(start, tz);
  const nextDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1, 12));
  const nextKey = nextDate.toISOString().slice(0, 10);
  const end = zonedTimeToUtc(
    tz,
    Number(nextKey.slice(0, 4)),
    Number(nextKey.slice(5, 7)),
    Number(nextKey.slice(8, 10)),
  );
  const techs = (await loadTechnicians(dealerId)).filter(
    (tech) => targetTechId == null || tech.id === targetTechId,
  );
  const techIds = techs.map((tech) => tech.id);
  if (techIds.length === 0) {
    res.json(
      GetDailyTechnicianTimesheetResponse.parse({
        date,
        timezone: tz,
        summary: {
          availableHours: 0,
          bookedHours: 0,
          approvedSoldHours: 0,
          invoicedSoldHours: 0,
          invoicedHoursKnown: true,
          loggedActualHours: 0,
          existingTimerHours: 0,
          remainingCapacityHours: 0,
          efficiencyPct: null,
          productivityPct: null,
        },
        rows: [],
      }),
    );
    return;
  }

  const settings = await getServiceSettings(dealerId);
  const [availability, booked, entries, approvedCards, invoices, timers] =
    await Promise.all([
      db
        .select({
          technicianUserId: technicianDailyAvailabilityTable.technicianUserId,
          availableHours: technicianDailyAvailabilityTable.availableHours,
        })
        .from(technicianDailyAvailabilityTable)
        .where(
          and(
            eq(technicianDailyAvailabilityTable.dealerId, dealerId),
            eq(technicianDailyAvailabilityTable.workDate, date),
            inArray(technicianDailyAvailabilityTable.technicianUserId, techIds),
          ),
        ),
      db
        .select({
          technicianUserId: serviceOrdersTable.technicianUserId,
          bookedHours: sql<number>`coalesce(sum(${serviceOrdersTable.estimatedHours}), 0)`,
        })
        .from(serviceOrdersTable)
        .where(
          and(
            eq(serviceOrdersTable.dealerId, dealerId),
            eq(serviceOrdersTable.scheduledDate, date),
            inArray(serviceOrdersTable.technicianUserId, techIds),
            sql`${serviceOrdersTable.status} <> 'cancelled'`,
          ),
        )
        .groupBy(serviceOrdersTable.technicianUserId),
      db
        .select({
          id: technicianTimesheetEntriesTable.id,
          technicianUserId: technicianTimesheetEntriesTable.technicianUserId,
          workDate: technicianTimesheetEntriesTable.workDate,
          jobCardId: technicianTimesheetEntriesTable.jobCardId,
          durationMinutes: technicianTimesheetEntriesTable.durationMinutes,
          note: technicianTimesheetEntriesTable.note,
          source: technicianTimesheetEntriesTable.source,
          createdAt: technicianTimesheetEntriesTable.createdAt,
          updatedAt: technicianTimesheetEntriesTable.updatedAt,
          jobCardTitle: jobCardsTable.title,
          customerName: serviceOrdersTable.customerName,
        })
        .from(technicianTimesheetEntriesTable)
        .leftJoin(
          jobCardsTable,
          and(
            eq(jobCardsTable.id, technicianTimesheetEntriesTable.jobCardId),
            eq(jobCardsTable.dealerId, dealerId),
          ),
        )
        .leftJoin(
          serviceOrdersTable,
          and(
            eq(serviceOrdersTable.id, jobCardsTable.serviceOrderId),
            eq(serviceOrdersTable.dealerId, dealerId),
          ),
        )
        .where(
          and(
            eq(technicianTimesheetEntriesTable.dealerId, dealerId),
            eq(technicianTimesheetEntriesTable.workDate, date),
            inArray(technicianTimesheetEntriesTable.technicianUserId, techIds),
          ),
        )
        .orderBy(desc(technicianTimesheetEntriesTable.createdAt)),
      db
        .select({
          id: jobCardsTable.id,
          technicianUserId: jobCardsTable.technicianUserId,
          title: jobCardsTable.title,
          laborHours: jobCardsTable.laborHours,
          quotedLaborHours: jobCardsTable.quotedLaborHours,
          customerName: serviceOrdersTable.customerName,
          vehicleInfo: serviceOrdersTable.vehicleInfo,
        })
        .from(jobCardsTable)
        .innerJoin(
          serviceOrdersTable,
          and(
            eq(serviceOrdersTable.id, jobCardsTable.serviceOrderId),
            eq(serviceOrdersTable.dealerId, dealerId),
          ),
        )
        .where(
          and(
            eq(jobCardsTable.dealerId, dealerId),
            inArray(jobCardsTable.technicianUserId, techIds),
            eq(jobCardsTable.estimateApprovedVersion, jobCardsTable.estimateVersion),
            gte(jobCardsTable.estimateApprovalAt, start),
            lt(jobCardsTable.estimateApprovalAt, end),
            sql`${jobCardsTable.estimateApprovalAt} is not null`,
            sql`${jobCardsTable.status} <> 'cancelled'`,
          ),
        ),
      db
        .select({
          id: serviceInvoicesTable.id,
          jobCardId: serviceInvoicesTable.jobCardId,
          technicianUserId: jobCardsTable.technicianUserId,
          title: jobCardsTable.title,
          customerName: serviceOrdersTable.customerName,
          vehicleInfo: serviceOrdersTable.vehicleInfo,
          invoicedLaborHours: serviceInvoicesTable.invoicedLaborHours,
          issuedAt: sql<Date>`coalesce(${serviceInvoicesTable.issuedAt}, ${serviceInvoicesTable.createdAt})`,
        })
        .from(serviceInvoicesTable)
        .innerJoin(
          jobCardsTable,
          and(
            eq(jobCardsTable.id, serviceInvoicesTable.jobCardId),
            eq(jobCardsTable.dealerId, dealerId),
          ),
        )
        .innerJoin(
          serviceOrdersTable,
          and(
            eq(serviceOrdersTable.id, serviceInvoicesTable.serviceOrderId),
            eq(serviceOrdersTable.dealerId, dealerId),
          ),
        )
        .where(
          and(
            eq(serviceInvoicesTable.dealerId, dealerId),
            inArray(jobCardsTable.technicianUserId, techIds),
            sql`${serviceInvoicesTable.status} <> 'void'`,
            gte(sql`coalesce(${serviceInvoicesTable.issuedAt}, ${serviceInvoicesTable.createdAt})`, start),
            lt(sql`coalesce(${serviceInvoicesTable.issuedAt}, ${serviceInvoicesTable.createdAt})`, end),
          ),
        ),
      db
        .select({
          technicianUserId: jobCardsTable.technicianUserId,
          timerHours: sql<number>`coalesce(sum(${jobCardsTable.timerSeconds} + coalesce(greatest(0, extract(epoch from (now() - ${jobCardsTable.timerStartedAt})))::int, 0)), 0) / 3600.0`,
        })
        .from(jobCardsTable)
        .where(
          and(
            eq(jobCardsTable.dealerId, dealerId),
            inArray(jobCardsTable.technicianUserId, techIds),
            sql`${jobCardsTable.status} <> 'cancelled'`,
          ),
        )
        .groupBy(jobCardsTable.technicianUserId),
    ]);

  const availabilityByTech = new Map(
    availability.map((row) => [row.technicianUserId, Number(row.availableHours)]),
  );
  const bookedByTech = new Map(
    booked.map((row) => [row.technicianUserId!, Number(row.bookedHours ?? 0)]),
  );
  const entriesByTech = new Map<number, EntryWithJob[]>();
  for (const row of entries) {
    const list = entriesByTech.get(row.technicianUserId) ?? [];
    list.push(row);
    entriesByTech.set(row.technicianUserId, list);
  }
  const approvedByTech = new Map<number, typeof approvedCards>();
  for (const card of approvedCards) {
    const list = approvedByTech.get(card.technicianUserId!) ?? [];
    list.push(card);
    approvedByTech.set(card.technicianUserId!, list);
  }
  const invoiceByTech = new Map<number, typeof invoices>();
  for (const invoice of invoices) {
    const list = invoiceByTech.get(invoice.technicianUserId!) ?? [];
    list.push(invoice);
    invoiceByTech.set(invoice.technicianUserId!, list);
  }
  const timerByTech = new Map(
    timers.map((row) => [row.technicianUserId!, Number(row.timerHours ?? 0)]),
  );

  const rows = techs.map((tech) => {
    const techEntries = entriesByTech.get(tech.id) ?? [];
    const techApproved = approvedByTech.get(tech.id) ?? [];
    const techInvoices = invoiceByTech.get(tech.id) ?? [];
    const availableHours = availabilityByTech.get(tech.id) ?? settings.techWorkHoursPerDay;
    const bookedHours = Number(bookedByTech.get(tech.id) ?? 0);
    const approvedSoldHours = techApproved.reduce(
      (sum, card) => sum + effectiveSoldHours(card.quotedLaborHours, card.laborHours),
      0,
    );
    const knownInvoices = techInvoices.filter(
      (invoice) => invoice.invoicedLaborHours != null,
    );
    const invoicedSoldHours = knownInvoices.reduce(
      (sum, invoice) => sum + Number(invoice.invoicedLaborHours ?? 0),
      0,
    );
    const loggedActualHours =
      techEntries.reduce((sum, entry) => sum + entry.durationMinutes, 0) / 60;
    const metrics = calculateTechnicianMetrics({
      availableHours,
      bookedHours,
      approvedSoldHours,
      invoicedSoldHours,
      invoicedHoursKnown: knownInvoices.length === techInvoices.length,
      loggedActualHours,
      existingTimerHours: timerByTech.get(tech.id) ?? 0,
    });
    return {
      technicianUserId: tech.id,
      technicianName: tech.name,
      ...metrics,
      availabilitySource: availabilityByTech.has(tech.id) ? ("override" as const) : ("default" as const),
      entries: techEntries.map(entryPayload),
      approvedJobs: techApproved.map((card) => ({
        jobCardId: card.id,
        title: card.title,
        customerName: card.customerName,
        vehicleInfo: card.vehicleInfo,
        hours: roundHours(effectiveSoldHours(card.quotedLaborHours, card.laborHours)),
      })),
      invoicedJobs: techInvoices
        .filter((invoice) => invoice.invoicedLaborHours != null)
        .map((invoice) => ({
          jobCardId: invoice.jobCardId,
          title: invoice.title,
          customerName: invoice.customerName,
          vehicleInfo: invoice.vehicleInfo,
          hours: roundHours(Number(invoice.invoicedLaborHours)),
        })),
    };
  });
  const summary = aggregateTechnicianMetrics(
    rows.map((row) => ({
      availableHours: row.availableHours,
      bookedHours: row.bookedHours,
      approvedSoldHours: row.approvedSoldHours,
      invoicedSoldHours: row.invoicedSoldHours,
      invoicedHoursKnown: row.invoicedHoursKnown,
      loggedActualHours: row.loggedActualHours,
      existingTimerHours: row.existingTimerHours,
      remainingCapacityHours: row.remainingCapacityHours,
      efficiencyPct: row.efficiencyPct,
      productivityPct: row.productivityPct,
    })),
  );
  res.json(
    GetDailyTechnicianTimesheetResponse.parse({
      date,
      timezone: tz,
      summary: {
        ...summary,
      },
      rows,
    }),
  );
});

router.post("/service-timesheets", async (req, res): Promise<void> => {
  const parsed = CreateTechnicianTimesheetEntryBody.safeParse(req.body);
  if (!parsed.success || !isValidDay(parsed.data?.workDate ?? "")) {
    res.status(400).json({ error: "workDate must be a valid YYYY-MM-DD" });
    return;
  }
  const dealerId = activeDealerId(res);
  const viewer = res.locals.user;
  const input = parsed.data;
  if (isTechnician(viewer) && input.technicianUserId !== viewer!.id) {
    res.status(403).json({ error: "Technicians may only log their own time" });
    return;
  }
  if (!isTechnician(viewer) && !isApprover(viewer)) {
    res.status(403).json({ error: "Only technicians or service managers may log time" });
    return;
  }
  if (!(await assertTechnicianInDealer(dealerId, input.technicianUserId))) {
    res.status(404).json({ error: "Technician not found in this dealership" });
    return;
  }
  if (input.jobCardId != null) {
    const [card] = await db
      .select({ id: jobCardsTable.id, title: jobCardsTable.title })
      .from(jobCardsTable)
      .where(
        and(
          eq(jobCardsTable.id, input.jobCardId),
          eq(jobCardsTable.dealerId, dealerId),
          eq(jobCardsTable.technicianUserId, input.technicianUserId),
        ),
      );
    if (!card) {
      res.status(403).json({ error: "The job card is not assigned to this technician" });
      return;
    }
  }
  try {
    const row = await db.transaction(async (tx) => {
      if (
        !(await validateDailyTotal(
          tx,
          dealerId,
          input.technicianUserId,
          input.workDate,
          input.durationMinutes,
        ))
      ) {
        throw new Error("A technician's manual daily time cannot exceed 24 hours");
      }
      const [created] = await tx
        .insert(technicianTimesheetEntriesTable)
        .values({
          dealerId,
          technicianUserId: input.technicianUserId,
          workDate: input.workDate,
          jobCardId: input.jobCardId ?? null,
          durationMinutes: input.durationMinutes,
          note: input.note?.trim() || null,
          source: "manual",
          createdByUserId: viewer?.id ?? null,
          updatedByUserId: viewer?.id ?? null,
        })
        .returning();
      return created!;
    });
    const output = await loadEntry(dealerId, row.id);
    res.status(201).json(CreateTechnicianTimesheetEntryResponse.parse(entryPayload(output!)));
  } catch (error) {
    if (readError(error).includes("daily time")) {
      res.status(422).json({ error: readError(error) });
      return;
    }
    if ((error as { code?: string })?.code === "23505") {
      res.status(409).json({ error: "A manual entry already exists for this job card and dealer day" });
      return;
    }
    throw error;
  }
});

async function canEditEntry(
  dealerId: number,
  entryId: number,
  viewer: {
    id?: number;
    roleName?: string | null;
    isSuperAdmin?: boolean;
  } | null | undefined,
): Promise<EntryWithJob | null> {
  const entry = await loadEntry(dealerId, entryId);
  if (!entry) return null;
  if (isApprover(viewer) || (isTechnician(viewer) && entry.technicianUserId === viewer!.id)) {
    return entry;
  }
  return null;
}

router.patch("/service-timesheets/entries/:id", async (req, res): Promise<void> => {
  const params = UpdateTechnicianTimesheetEntryParams.safeParse(req.params);
  const parsed = UpdateTechnicianTimesheetEntryBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: "Invalid timesheet update" });
    return;
  }
  const dealerId = activeDealerId(res);
  const current = await loadEntry(dealerId, params.data.id);
  if (!current) {
    res.status(404).json({ error: "Timesheet entry not found" });
    return;
  }
  if (!(await canEditEntry(dealerId, current.id, res.locals.user))) {
    res.status(403).json({ error: "You may only edit your own time entries" });
    return;
  }
  try {
    const row = await db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(technicianTimesheetEntriesTable)
        .where(
          and(
            eq(technicianTimesheetEntriesTable.id, current.id),
            eq(technicianTimesheetEntriesTable.dealerId, dealerId),
          ),
        )
        .for("update");
      if (!locked) throw new Error("Timesheet entry not found");
      const duration = parsed.data.durationMinutes ?? locked.durationMinutes;
      if (
        !(await validateDailyTotal(
          tx,
          dealerId,
          locked.technicianUserId,
          locked.workDate,
          duration,
          locked.id,
        ))
      ) {
        throw new Error("A technician's manual daily time cannot exceed 24 hours");
      }
      const [updated] = await tx
        .update(technicianTimesheetEntriesTable)
        .set({
          durationMinutes: duration,
          note: parsed.data.note === undefined ? locked.note : parsed.data.note?.trim() || null,
          updatedByUserId: res.locals.user?.id ?? null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(technicianTimesheetEntriesTable.id, locked.id),
            eq(technicianTimesheetEntriesTable.dealerId, dealerId),
          ),
        )
        .returning();
      return updated!;
    });
    const output = await loadEntry(dealerId, row.id);
    res.json(UpdateTechnicianTimesheetEntryResponse.parse(entryPayload(output!)));
  } catch (error) {
    if (readError(error).includes("daily time")) {
      res.status(422).json({ error: readError(error) });
      return;
    }
    throw error;
  }
});

router.delete("/service-timesheets/entries/:id", async (req, res): Promise<void> => {
  const params = DeleteTechnicianTimesheetEntryParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid timesheet entry id" });
    return;
  }
  const dealerId = activeDealerId(res);
  const current = await loadEntry(dealerId, params.data.id);
  if (!current) {
    res.status(404).json({ error: "Timesheet entry not found" });
    return;
  }
  if (!(await canEditEntry(dealerId, current.id, res.locals.user))) {
    res.status(403).json({ error: "You may only delete your own time entries" });
    return;
  }
  await db
    .delete(technicianTimesheetEntriesTable)
    .where(
      and(
        eq(technicianTimesheetEntriesTable.id, current.id),
        eq(technicianTimesheetEntriesTable.dealerId, dealerId),
      ),
    );
  res.status(204).end();
});

router.patch(
  "/service-timesheets/availability/:technicianUserId",
  async (req, res): Promise<void> => {
    const params = SetTechnicianDailyAvailabilityParams.safeParse(req.params);
    const parsed = SetTechnicianDailyAvailabilityBody.safeParse(req.body);
    if (
      !params.success ||
      !parsed.success ||
      !isValidDay(parsed.data?.workDate ?? "")
    ) {
      res.status(400).json({ error: "workDate must be a valid YYYY-MM-DD" });
      return;
    }
    const dealerId = activeDealerId(res);
    if (!isApprover(res.locals.user)) {
      res.status(403).json({ error: "Only service managers may override availability" });
      return;
    }
    if (!(await assertTechnicianInDealer(dealerId, params.data.technicianUserId))) {
      res.status(404).json({ error: "Technician not found in this dealership" });
      return;
    }
    const [row] = await db
      .insert(technicianDailyAvailabilityTable)
      .values({
        dealerId,
        technicianUserId: params.data.technicianUserId,
        workDate: parsed.data.workDate,
        availableHours: parsed.data.availableHours,
        updatedByUserId: res.locals.user?.id ?? null,
      })
      .onConflictDoUpdate({
        target: [
          technicianDailyAvailabilityTable.dealerId,
          technicianDailyAvailabilityTable.technicianUserId,
          technicianDailyAvailabilityTable.workDate,
        ],
        set: {
          availableHours: parsed.data.availableHours,
          updatedByUserId: res.locals.user?.id ?? null,
          updatedAt: new Date(),
        },
      })
      .returning();
    res.json(
      SetTechnicianDailyAvailabilityResponse.parse({
        technicianUserId: row!.technicianUserId,
        workDate: row!.workDate,
        availableHours: row!.availableHours,
        source: "override",
      }),
    );
  },
);

export default router;