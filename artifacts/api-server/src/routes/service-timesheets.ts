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
  technicianWorkSegmentLedgerTable,
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
  calculateDealerTimerResidualHours,
  calculateTechnicianMetrics,
  manualJobDayKey,
  roundHours,
  shouldCountAutomaticSlice,
  splitTimerSegmentByDealerDay,
  type TimerLedgerSegment,
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
  originalJobCardId: number | null;
  durationMinutes: number;
  note: string | null;
  source: string;
  createdAt: Date;
  updatedAt: Date;
  jobCardTitle: string | null;
  customerName: string | null;
};

type AutomaticEntry = {
  id: number;
  technicianUserId: number;
  workDate: string;
  jobCardId: number;
  jobCardTitle: string | null;
  customerName: string | null;
  durationSeconds: number;
  startAt: Date;
  endAt: Date;
  technicianNameSnapshot: string | null;
  counted: boolean;
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
    durationSeconds: null,
    startAt: null,
    endAt: null,
    note: row.note,
    source: "manual" as const,
    sourceMetadata: null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function automaticEntryPayload(row: AutomaticEntry) {
  return {
    // Virtual automatic rows can never target a positive serial manual-entry
    // id. PATCH/DELETE against this value therefore remains read-only (404)
    // even if a ledger id happens to equal a manual table id.
    id: -row.id,
    technicianUserId: row.technicianUserId,
    workDate: row.workDate,
    jobCardId: row.jobCardId,
    jobCardTitle: row.jobCardTitle,
    customerName: row.customerName,
    // Manual entry APIs use whole minutes.  Keep the exact ledger duration
    // alongside this display value so a billable rounding rule cannot alter
    // the actual captured interval.
    durationMinutes: Math.max(1, Math.ceil(row.durationSeconds / 60)),
    durationSeconds: row.durationSeconds,
    startAt: row.startAt,
    endAt: row.endAt,
    note: null,
    source: "automatic" as const,
    sourceMetadata: {
      timerSegmentId: row.id,
      technicianNameSnapshot: row.technicianNameSnapshot,
      counted: row.counted,
      exclusionReason: row.counted
        ? null
        : ("manual_job_day_supersedes_automatic" as const),
    },
    createdAt: row.endAt,
    updatedAt: row.endAt,
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
      originalJobCardId: technicianTimesheetEntriesTable.originalJobCardId,
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

async function hasAutomaticJobWorkOnDay(
  query: any,
  dealerId: number,
  technicianUserId: number,
  jobCardId: number,
  workDate: string,
  timezone: string,
): Promise<boolean> {
  const dayStart = zonedStartOfDay(workDate, timezone);
  const dayEnd = zonedStartOfDay(
    new Date(Date.UTC(
      Number(workDate.slice(0, 4)),
      Number(workDate.slice(5, 7)) - 1,
      Number(workDate.slice(8, 10)) + 1,
      12,
    )).toISOString().slice(0, 10),
    timezone,
  );
  const closed = await query
    .select({
      id: technicianWorkSegmentLedgerTable.id,
      technicianNameSnapshot: technicianWorkSegmentLedgerTable.technicianNameSnapshot,
      dealerTimezoneSnapshot: technicianWorkSegmentLedgerTable.dealerTimezoneSnapshot,
      startedAt: technicianWorkSegmentLedgerTable.segmentStartedAt,
      endedAt: technicianWorkSegmentLedgerTable.segmentEndedAt,
    })
    .from(technicianWorkSegmentLedgerTable)
    .where(
      and(
        eq(technicianWorkSegmentLedgerTable.dealerId, dealerId),
        eq(technicianWorkSegmentLedgerTable.jobCardId, jobCardId),
        eq(technicianWorkSegmentLedgerTable.technicianUserId, technicianUserId),
        sql`${technicianWorkSegmentLedgerTable.durationSeconds} is not null`,
        sql`${technicianWorkSegmentLedgerTable.segmentStartedAt} < ${dayEnd.toISOString()}::timestamptz + interval '26 hours'`,
        sql`${technicianWorkSegmentLedgerTable.segmentEndedAt} > ${dayStart.toISOString()}::timestamptz - interval '26 hours'`,
      ),
    );
  if (
    closed.some(
      (segment: {
        id: number;
        technicianNameSnapshot: string | null;
        dealerTimezoneSnapshot: string;
        startedAt: Date | null;
        endedAt: Date | null;
      }) =>
        segment.startedAt != null &&
        segment.endedAt != null &&
        splitTimerSegmentByDealerDay(
          {
            id: segment.id,
            dealerId,
            jobCardId,
            technicianUserId,
            technicianNameSnapshot: segment.technicianNameSnapshot,
            dealerTimezoneSnapshot: segment.dealerTimezoneSnapshot,
            startedAt: segment.startedAt,
            endedAt: segment.endedAt,
          },
          segment.dealerTimezoneSnapshot,
        ).some((slice) => slice.workDate === workDate),
    )
  ) {
    return true;
  }

  const [running] = await query
    .select({ startedAt: jobCardsTable.timerStartedAt })
    .from(jobCardsTable)
    .where(
      and(
        eq(jobCardsTable.id, jobCardId),
        eq(jobCardsTable.dealerId, dealerId),
        eq(jobCardsTable.technicianUserId, technicianUserId),
        sql`${jobCardsTable.timerStartedAt} is not null`,
        sql`${jobCardsTable.timerStartedAt} < ${dayEnd}`,
      ),
    )
    .limit(1);
  if (!running?.startedAt) return false;
  // A pre-ledger running timer remains legacy/unallocated. It must not block a
  // manual correction because it has no captured technician/session evidence.
  const [capturedStart] = await query
    .select({
      id: technicianWorkSegmentLedgerTable.id,
      technicianNameSnapshot: technicianWorkSegmentLedgerTable.technicianNameSnapshot,
      dealerTimezoneSnapshot: technicianWorkSegmentLedgerTable.dealerTimezoneSnapshot,
    })
    .from(technicianWorkSegmentLedgerTable)
    .where(
      and(
        eq(technicianWorkSegmentLedgerTable.dealerId, dealerId),
        eq(technicianWorkSegmentLedgerTable.jobCardId, jobCardId),
        eq(technicianWorkSegmentLedgerTable.technicianUserId, technicianUserId),
        inArray(technicianWorkSegmentLedgerTable.eventType, ["start", "resume"]),
        eq(technicianWorkSegmentLedgerTable.segmentStartedAt, running.startedAt),
      ),
    )
    .limit(1);
  return Boolean(
    capturedStart &&
      splitTimerSegmentByDealerDay(
        {
          id: capturedStart.id,
          dealerId,
          jobCardId,
          technicianUserId,
          technicianNameSnapshot: capturedStart.technicianNameSnapshot,
          dealerTimezoneSnapshot: capturedStart.dealerTimezoneSnapshot,
          startedAt: running.startedAt,
          endedAt: null,
        },
        capturedStart.dealerTimezoneSnapshot,
      ).some((slice) => slice.workDate === workDate),
  );
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
  // Keep population discovery and active-segment rendering on the same report
  // boundary so an active historic identity cannot flicker in/out of a row.
  const reportNow = new Date();
  // A role or dealer-membership change must not erase work that was already
  // captured for this dealer. Build the report population from current
  // technicians plus identities represented by this dealer-day's immutable
  // ledger/manual evidence. This is deliberately a read-only expansion: all
  // write routes still require a current Technician membership.
  const [
    currentTechnicians,
    historicalManualTechnicians,
    ledgerCandidates,
    activeLedgerCandidates,
  ] =
    await Promise.all([
      loadTechnicians(dealerId),
      db
        .select({
          technicianUserId: technicianTimesheetEntriesTable.technicianUserId,
          name: usersTable.name,
          email: usersTable.email,
        })
        .from(technicianTimesheetEntriesTable)
        .leftJoin(
          usersTable,
          eq(usersTable.id, technicianTimesheetEntriesTable.technicianUserId),
        )
        .where(
          and(
            eq(technicianTimesheetEntriesTable.dealerId, dealerId),
            eq(technicianTimesheetEntriesTable.workDate, date),
          ),
        ),
      db
        .select({
          id: technicianWorkSegmentLedgerTable.id,
          technicianUserId: technicianWorkSegmentLedgerTable.technicianUserId,
          technicianNameSnapshot: technicianWorkSegmentLedgerTable.technicianNameSnapshot,
          dealerTimezoneSnapshot: technicianWorkSegmentLedgerTable.dealerTimezoneSnapshot,
          startedAt: technicianWorkSegmentLedgerTable.segmentStartedAt,
          endedAt: technicianWorkSegmentLedgerTable.segmentEndedAt,
          name: usersTable.name,
          email: usersTable.email,
        })
        .from(technicianWorkSegmentLedgerTable)
        .leftJoin(
          usersTable,
          eq(usersTable.id, technicianWorkSegmentLedgerTable.technicianUserId),
        )
        .where(
          and(
            eq(technicianWorkSegmentLedgerTable.dealerId, dealerId),
            sql`${technicianWorkSegmentLedgerTable.durationSeconds} is not null`,
            sql`${technicianWorkSegmentLedgerTable.segmentStartedAt} < ${end.toISOString()}::timestamptz + interval '26 hours'`,
            sql`${technicianWorkSegmentLedgerTable.segmentEndedAt} > ${start.toISOString()}::timestamptz - interval '26 hours'`,
          ),
        ),
      db
        .select({
          id: technicianWorkSegmentLedgerTable.id,
          technicianUserId: technicianWorkSegmentLedgerTable.technicianUserId,
          technicianNameSnapshot: technicianWorkSegmentLedgerTable.technicianNameSnapshot,
          dealerTimezoneSnapshot: technicianWorkSegmentLedgerTable.dealerTimezoneSnapshot,
          startedAt: technicianWorkSegmentLedgerTable.segmentStartedAt,
          endedAt: technicianWorkSegmentLedgerTable.segmentEndedAt,
          name: usersTable.name,
          email: usersTable.email,
        })
        .from(technicianWorkSegmentLedgerTable)
        .innerJoin(
          jobCardsTable,
          and(
            eq(jobCardsTable.id, technicianWorkSegmentLedgerTable.jobCardId),
            eq(jobCardsTable.dealerId, dealerId),
            eq(
              jobCardsTable.timerStartedAt,
              technicianWorkSegmentLedgerTable.segmentStartedAt,
            ),
          ),
        )
        .leftJoin(
          usersTable,
          eq(usersTable.id, technicianWorkSegmentLedgerTable.technicianUserId),
        )
        .where(
          and(
            eq(technicianWorkSegmentLedgerTable.dealerId, dealerId),
            inArray(technicianWorkSegmentLedgerTable.eventType, ["start", "resume"]),
            sql`${technicianWorkSegmentLedgerTable.segmentEndedAt} is null`,
            sql`${jobCardsTable.timerStartedAt} is not null`,
            sql`${technicianWorkSegmentLedgerTable.segmentStartedAt} < ${end.toISOString()}::timestamptz + interval '26 hours'`,
          ),
        ),
    ]);
  const historicalNames = new Map<number, string>();
  for (const row of historicalManualTechnicians) {
    historicalNames.set(
      row.technicianUserId,
      row.name ?? row.email ?? `User #${row.technicianUserId}`,
    );
  }
  for (const segment of [...ledgerCandidates, ...activeLedgerCandidates]) {
    if (
      segment.technicianUserId == null ||
      segment.startedAt == null ||
      !splitTimerSegmentByDealerDay(
        {
          id: segment.id,
          dealerId,
          jobCardId: 0,
          technicianUserId: segment.technicianUserId,
          technicianNameSnapshot: segment.technicianNameSnapshot,
          dealerTimezoneSnapshot: segment.dealerTimezoneSnapshot,
          startedAt: segment.startedAt,
          endedAt: segment.endedAt,
        },
        segment.dealerTimezoneSnapshot,
        reportNow,
      ).some((slice) => slice.workDate === date)
    ) {
      continue;
    }
    // Ledger snapshots preserve the historical display identity even when the
    // current user record or dealer membership is gone.
    historicalNames.set(
      segment.technicianUserId,
      segment.technicianNameSnapshot ??
        segment.name ??
        segment.email ??
        `User #${segment.technicianUserId}`,
    );
  }
  const currentTechIds = new Set(currentTechnicians.map((tech) => tech.id));
  const techs = [
    // When a dealer-day contains ledger evidence, its identity snapshot is the
    // historical display name. This also keeps the row stable if that person
    // is subsequently re-roled or removed from the dealer.
    ...currentTechnicians.map((tech) => ({
      ...tech,
      name: historicalNames.get(tech.id) ?? tech.name,
    })),
    ...[...historicalNames].flatMap(([id, name]) =>
      currentTechIds.has(id) ? [] : [{ id, name }],
    ),
  ]
    .filter((tech) => targetTechId == null || tech.id === targetTechId)
    .sort((a, b) => a.id - b.id);
  if (targetTechId != null && techs.length === 0) {
    res.status(404).json({ error: "Technician not found in this dealership" });
    return;
  }
  const techIds = techs.map((tech) => tech.id);

  const settings = await getServiceSettings(dealerId);
  const [
    availability,
    booked,
    entries,
    approvedCards,
    invoices,
    timerCards,
    closedLedgerSegments,
    capturedLedgerTotals,
    capturedLedgerByJob,
    activeCards,
    activeLedgerStarts,
  ] =
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
          originalJobCardId: technicianTimesheetEntriesTable.originalJobCardId,
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
      // Cumulative timer residuals are dealer-level and are reconciled per
      // job card below. Do not filter cancelled cards or current assignees:
      // both would make legitimate pre-cancellation elapsed time disappear.
      db
        .select({
          jobCardId: jobCardsTable.id,
          cumulativeTimerSeconds: sql<number>`${jobCardsTable.timerSeconds} + coalesce(greatest(0, extract(epoch from (${reportNow.toISOString()}::timestamptz - ${jobCardsTable.timerStartedAt})))::int, 0)`,
        })
        .from(jobCardsTable)
        .where(eq(jobCardsTable.dealerId, dealerId)),
      // A closed ledger record represents one exact worked interval.  The
      // paired start/resume audit event intentionally has no duration and is
      // not counted a second time.
      db
        .select({
          id: technicianWorkSegmentLedgerTable.id,
          technicianUserId: technicianWorkSegmentLedgerTable.technicianUserId,
          technicianNameSnapshot: technicianWorkSegmentLedgerTable.technicianNameSnapshot,
          dealerTimezoneSnapshot: technicianWorkSegmentLedgerTable.dealerTimezoneSnapshot,
          jobCardId: technicianWorkSegmentLedgerTable.jobCardId,
          startedAt: technicianWorkSegmentLedgerTable.segmentStartedAt,
          endedAt: technicianWorkSegmentLedgerTable.segmentEndedAt,
          jobCardTitle: jobCardsTable.title,
          customerName: serviceOrdersTable.customerName,
        })
        .from(technicianWorkSegmentLedgerTable)
        .leftJoin(
          jobCardsTable,
          and(
            eq(jobCardsTable.id, technicianWorkSegmentLedgerTable.jobCardId),
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
            eq(technicianWorkSegmentLedgerTable.dealerId, dealerId),
            inArray(technicianWorkSegmentLedgerTable.technicianUserId, techIds),
            sql`${technicianWorkSegmentLedgerTable.durationSeconds} is not null`,
            // A historical segment's captured timezone can differ from the
            // dealer's current setting.  +/-26h covers every IANA UTC offset
            // around the requested civil date; exact inclusion happens after
            // timezone-aware splitting below.
            sql`${technicianWorkSegmentLedgerTable.segmentStartedAt} < ${end.toISOString()}::timestamptz + interval '26 hours'`,
            sql`${technicianWorkSegmentLedgerTable.segmentEndedAt} > ${start.toISOString()}::timestamptz - interval '26 hours'`,
          ),
        ),
      // This all-time figure is solely for explaining the legacy cumulative
      // timer.  It is never presented as a daily actual.
      db
        .select({
          technicianUserId: technicianWorkSegmentLedgerTable.technicianUserId,
          capturedTimerSeconds: sql<number>`coalesce(sum(${technicianWorkSegmentLedgerTable.durationSeconds}), 0)`,
        })
        .from(technicianWorkSegmentLedgerTable)
        .where(
          and(
            eq(technicianWorkSegmentLedgerTable.dealerId, dealerId),
            inArray(technicianWorkSegmentLedgerTable.technicianUserId, techIds),
            sql`${technicianWorkSegmentLedgerTable.durationSeconds} is not null`,
          ),
        )
        .groupBy(technicianWorkSegmentLedgerTable.technicianUserId),
      db
        .select({
          jobCardId: technicianWorkSegmentLedgerTable.jobCardId,
          capturedTimerSeconds: sql<number>`coalesce(sum(${technicianWorkSegmentLedgerTable.durationSeconds}), 0)`,
        })
        .from(technicianWorkSegmentLedgerTable)
        .where(
          and(
            eq(technicianWorkSegmentLedgerTable.dealerId, dealerId),
            sql`${technicianWorkSegmentLedgerTable.durationSeconds} is not null`,
          ),
        )
        .groupBy(technicianWorkSegmentLedgerTable.jobCardId),
      db
        .select({
          jobCardId: jobCardsTable.id,
          technicianUserId: jobCardsTable.technicianUserId,
          startedAt: jobCardsTable.timerStartedAt,
          jobCardTitle: jobCardsTable.title,
          customerName: serviceOrdersTable.customerName,
        })
        .from(jobCardsTable)
        .leftJoin(
          serviceOrdersTable,
          and(
            eq(serviceOrdersTable.id, jobCardsTable.serviceOrderId),
            eq(serviceOrdersTable.dealerId, dealerId),
          ),
        )
        .where(
          and(
            eq(jobCardsTable.dealerId, dealerId),
            sql`${jobCardsTable.timerStartedAt} is not null`,
          ),
        ),
      db
        .select({
          id: technicianWorkSegmentLedgerTable.id,
          technicianUserId: technicianWorkSegmentLedgerTable.technicianUserId,
          technicianNameSnapshot: technicianWorkSegmentLedgerTable.technicianNameSnapshot,
          dealerTimezoneSnapshot: technicianWorkSegmentLedgerTable.dealerTimezoneSnapshot,
          jobCardId: technicianWorkSegmentLedgerTable.jobCardId,
          startedAt: technicianWorkSegmentLedgerTable.segmentStartedAt,
          eventType: technicianWorkSegmentLedgerTable.eventType,
        })
        .from(technicianWorkSegmentLedgerTable)
        .where(
          and(
            eq(technicianWorkSegmentLedgerTable.dealerId, dealerId),
            inArray(technicianWorkSegmentLedgerTable.eventType, ["start", "resume"]),
            sql`${technicianWorkSegmentLedgerTable.segmentStartedAt} is not null`,
            sql`${technicianWorkSegmentLedgerTable.segmentEndedAt} is null`,
          ),
        ),
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
  const manualJobKeys = new Set(
    entries
      // Rows written before the immutable association migration still have a
      // live FK until their card is deleted. Use it only as that compatibility
      // fallback; the database trigger preserves it into originalJobCardId
      // before an FK ON DELETE SET NULL can erase the live link.
      .filter((entry) => entry.originalJobCardId != null || entry.jobCardId != null)
      .map((entry) =>
        manualJobDayKey(
          entry.technicianUserId,
          entry.originalJobCardId ?? entry.jobCardId!,
        ),
      ),
  );
  type LedgerSegmentWithJob = TimerLedgerSegment & {
    jobCardTitle: string | null;
    customerName: string | null;
  };
  const automaticSegments: LedgerSegmentWithJob[] = closedLedgerSegments.flatMap(
    (row) => {
      if (
        row.technicianUserId == null ||
        row.startedAt == null ||
        row.endedAt == null
      ) {
        return [];
      }
      return [{
        id: row.id,
        dealerId,
        jobCardId: row.jobCardId,
        technicianUserId: row.technicianUserId,
        technicianNameSnapshot: row.technicianNameSnapshot,
        dealerTimezoneSnapshot: row.dealerTimezoneSnapshot,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        jobCardTitle: row.jobCardTitle,
        customerName: row.customerName,
      }];
    },
  );
  const activeStartByJobAndTime = new Map(
    activeLedgerStarts.flatMap((row) =>
      row.technicianUserId != null && row.startedAt != null
        ? [[`${row.jobCardId}:${row.startedAt.getTime()}`, row] as const]
        : [],
    ),
  );
  const capturedTimerSecondsByJob = new Map(
    capturedLedgerByJob.map((row) => [
      row.jobCardId,
      Number(row.capturedTimerSeconds ?? 0),
    ]),
  );
  for (const card of activeCards) {
    if (card.technicianUserId == null || card.startedAt == null) continue;
    const start = activeStartByJobAndTime.get(
      `${card.jobCardId}:${card.startedAt.getTime()}`,
    );
    // A running legacy timer with no start ledger is intentionally left
    // unallocated. We must not invent an identity or start boundary for it.
    if (!start || start.technicianUserId == null) continue;
    const activeSeconds = Math.max(
      0,
      Math.round((reportNow.getTime() - card.startedAt.getTime()) / 1000),
    );
    capturedTimerSecondsByJob.set(
      card.jobCardId,
      (capturedTimerSecondsByJob.get(card.jobCardId) ?? 0) + activeSeconds,
    );
    automaticSegments.push({
      id: start.id,
      dealerId,
      jobCardId: card.jobCardId,
      technicianUserId: start.technicianUserId,
      technicianNameSnapshot: start.technicianNameSnapshot,
      dealerTimezoneSnapshot: start.dealerTimezoneSnapshot,
      startedAt: card.startedAt,
      endedAt: null,
      jobCardTitle: card.jobCardTitle,
      customerName: card.customerName,
    });
  }
  const automaticByTech = new Map<number, AutomaticEntry[]>();
  const capturedTimerSecondsByTech = new Map(
    capturedLedgerTotals.flatMap((row) =>
      row.technicianUserId == null
        ? []
        : [[row.technicianUserId, Number(row.capturedTimerSeconds ?? 0)] as const],
    ),
  );
  for (const segment of automaticSegments) {
    const isActive = segment.endedAt == null;
    const slices = splitTimerSegmentByDealerDay(
      segment,
      segment.dealerTimezoneSnapshot,
      reportNow,
    );
    if (isActive) {
      const seconds = slices.reduce((sum, slice) => sum + slice.durationSeconds, 0);
      capturedTimerSecondsByTech.set(
        segment.technicianUserId,
        (capturedTimerSecondsByTech.get(segment.technicianUserId) ?? 0) + seconds,
      );
    }
    for (const slice of slices) {
      if (slice.workDate !== date) continue;
      const counted = shouldCountAutomaticSlice(
        manualJobKeys,
        slice.technicianUserId,
        slice.jobCardId,
      );
      const list = automaticByTech.get(slice.technicianUserId) ?? [];
      list.push({
        id: slice.id,
        technicianUserId: slice.technicianUserId,
        workDate: slice.workDate,
        jobCardId: slice.jobCardId,
        jobCardTitle: segment.jobCardTitle,
        customerName: segment.customerName,
        durationSeconds: slice.durationSeconds,
        startAt: slice.startAt,
        endAt: slice.endAt,
        technicianNameSnapshot: slice.technicianNameSnapshot,
        counted,
      });
      automaticByTech.set(slice.technicianUserId, list);
    }
  }

  const rows = techs.map((tech) => {
    const techEntries = entriesByTech.get(tech.id) ?? [];
    const automaticEntries = automaticByTech.get(tech.id) ?? [];
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
    const manualActualHours =
      techEntries.reduce((sum, entry) => sum + entry.durationMinutes, 0) / 60;
    const automaticActualHours =
      automaticEntries
        .filter((entry) => entry.counted)
        .reduce((sum, entry) => sum + entry.durationSeconds, 0) / 3600;
    const metrics = calculateTechnicianMetrics({
      availableHours,
      bookedHours,
      approvedSoldHours,
      invoicedSoldHours,
      invoicedHoursKnown: knownInvoices.length === techInvoices.length,
      manualActualHours,
      automaticActualHours,
      capturedTimerHours:
        (capturedTimerSecondsByTech.get(tech.id) ?? 0) / 3600,
      // Cumulative job-card timers cannot be assigned to the current
      // technician after reassignment. Their residual is dealer-level only.
      existingTimerHours: 0,
      unallocatedTimerHours: 0,
    });
    return {
      technicianUserId: tech.id,
      technicianName: tech.name,
      ...metrics,
      legacyTimerScope: "dealer_summary_only" as const,
      availabilitySource: availabilityByTech.has(tech.id) ? ("override" as const) : ("default" as const),
       entries: [
         ...techEntries.map(entryPayload),
         ...automaticEntries.map(automaticEntryPayload),
       ].sort((a, b) => {
         const aAt = a.startAt ?? a.createdAt;
         const bAt = b.startAt ?? b.createdAt;
         return new Date(bAt).getTime() - new Date(aAt).getTime();
       }),
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
  const technicianSummary = aggregateTechnicianMetrics(
    rows.map((row) => ({
      availableHours: row.availableHours,
      bookedHours: row.bookedHours,
      approvedSoldHours: row.approvedSoldHours,
      invoicedSoldHours: row.invoicedSoldHours,
      invoicedHoursKnown: row.invoicedHoursKnown,
      manualActualHours: row.manualActualHours,
      automaticActualHours: row.automaticActualHours,
      capturedTimerHours: row.capturedTimerHours,
      existingTimerHours: row.existingTimerHours,
      remainingCapacityHours: row.remainingCapacityHours,
      efficiencyPct: row.efficiencyPct,
      productivityPct: row.productivityPct,
    })),
  );
  const existingTimerHours = roundHours(
    timerCards.reduce(
      (sum, card) => sum + Number(card.cumulativeTimerSeconds ?? 0),
      0,
    ) / 3600,
  );
  const summary = {
    ...technicianSummary,
    existingTimerHours,
    unallocatedTimerHours: calculateDealerTimerResidualHours(
      timerCards.map((card) => ({
        jobCardId: card.jobCardId,
        cumulativeTimerSeconds: Number(card.cumulativeTimerSeconds ?? 0),
      })),
      capturedTimerSecondsByJob,
    ),
    legacyTimerScope: "dealer" as const,
  };
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
    const timezone = await dealerTimezone(dealerId);
    const row = await db.transaction(async (tx) => {
      // The ledger trigger locks the technician id for timer transitions.
      // Taking that same lock makes the manual pre-check deterministic: a
      // completed automatic interval is rejected here; an automatic interval
      // that starts later remains visibly superseded on the read model.
      await tx.execute(
        sql`select pg_advisory_xact_lock(${input.technicianUserId}::bigint)`,
      );
      if (
        input.jobCardId != null &&
        (await hasAutomaticJobWorkOnDay(
          tx,
          dealerId,
          input.technicianUserId,
          input.jobCardId,
          input.workDate,
          timezone,
        ))
      ) {
        throw new Error(
          "Automatic timer work already exists for this technician, job card, and dealer day",
        );
      }
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
          originalJobCardId: input.jobCardId ?? null,
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
    if (readError(error).includes("Automatic timer work")) {
      res.status(409).json({ error: readError(error) });
      return;
    }
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
  // Ledger-derived rows are virtual/read-only and are never persisted in this
  // manual-entry table. Keep this guard for any future imported source too.
  if (entry.source !== "manual") return null;
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