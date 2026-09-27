import { getDealerPdfBranding } from "../lib/dealer-branding";
import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { eq, desc, and, or, isNull, isNotNull, ne, ilike, gte, lte, sql, inArray, notInArray, notExists, type SQL } from "drizzle-orm";
import {
  db,
  leadsTable,
  leadVehicleInterestsTable,
  tasksTable,
  vehiclesTable,
  usersTable,
  rolesTable,
  dealerUsersTable,
  timelineEventsTable,
  emailLogsTable,
  dealsTable,
  dealItemsTable,
  dealersTable,
  customersTable,
  bookingsTable,
  callLogsTable,
  agentsTable,
  gatesTable,
  quotesTable,
  quoteItemsTable,
  documentsTable,
  testDrivesTable,
  capacityBlocksTable,
  SOCIAL_SUB_PLATFORMS,
  type Lead,
  type ChecklistStage,
  reservationAllocationsTable,
} from "@workspace/db";
import {
  CreateLeadBody,
  UpdateLeadBody,
  GetLeadParams,
  UpdateLeadParams,
  DeleteLeadParams,
  ListLeadsQueryParams,
  ListLeadsResponse,
  GetLeadResponse,
  UpdateLeadResponse,
  ListLeadAdvisorsResponse,
  AssignLeadParams,
  AssignLeadBody,
  ScheduleTestDriveParams,
  ScheduleTestDriveBody,
  AdvanceLeadStageParams,
  AdvanceLeadStageBody,
  GetLeadReviewParams,
  GetLeadReviewResponse,
  LinkLeadAccountParams,
  LinkLeadAccountBody,
  CheckLeadAvailabilityParams,
  GetLeadTestDriveAvailabilityParams,
  GetLeadTestDriveAvailabilityResponse,
  RecordLeadDecisionParams,
  RecordLeadDecisionBody,
  GetLeadTimelineParams,
  GetLeadTimelineResponse,
  CreateLeadNoteParams,
  CreateLeadNoteBody,
  CreateLeadNoteResponse,
  NotifyLeadOwnerParams,
  NotifyLeadOwnerBody,
  NotifyLeadOwnerResponse,
  GetLeadQuoteParams,
  GetLeadQuoteResponse,
  DownloadLeadQuotePdfParams,
  ListLeadQuotesParams,
  ListLeadQuotesResponse,
  GenerateLeadQuoteParams,
  GenerateLeadQuoteBody,
  GenerateLeadQuoteResponse,
  RequestQuoteDiscountParams,
  RequestQuoteDiscountBody,
  RequestQuoteDiscountResponse,
  DownloadLeadQuoteVersionPdfParams,
  SendLeadQuoteParams,
  SendLeadQuoteBody,
  SendLeadQuoteResponse,
  GetLeadWhatsappThreadParams,
  GetLeadWhatsappThreadResponse,
  SendLeadWhatsappReplyParams,
  SendLeadWhatsappReplyBody,
  SendLeadWhatsappReplyResponse,
  SendLeadOutreachParams,
  SendLeadOutreachBody,
  SendLeadOutreachResponse,
  GetLeadAgentBriefParams,
  GetLeadAgentBriefResponse,
  CreateLeadResponse,
  ListLeadCallsParams,
  ListLeadCallsResponse,
  CreateLeadCallParams,
  CreateLeadCallBody,
  CreateLeadCallResponse,
  UpdateLeadCallParams,
  UpdateLeadCallBody,
  UpdateLeadCallResponse,
  GetLeadCallRecordingParams,
  SuggestCallSentimentParams,
  SuggestCallSentimentBody,
  SuggestCallSentimentResponse,
  ListLeadSourcesQueryParams,
  ListLeadSourcesResponse,
  RecordCallCentreDispositionBody,
} from "@workspace/api-zod";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { CallCentreError, recordCallCentreDisposition } from "../lib/call-centre";
import { isActiveCallCentreLead } from "../lib/call-centre-policy";
import { ObjectStorageService } from "../lib/objectStorage";
import {
  onLeadCreated,
  onLeadUpdated,
  sendTestDriveInviteEmail,
} from "../lib/email-triggers";
import { fetchRecordingAudio } from "../lib/call-transcription";
import {
  autoAssignLead,
  assignLeadToCreator,
  stampLeadAssignment,
} from "../lib/lead-assignment";
import { findOpenDuplicate, mergeIntoExistingLead } from "../lib/lead-dedup";
import { telephonyAdapter } from "../lib/telephony";
import {
  enqueueEmail,
  enqueueWhatsapp,
  whatsappOutboxDisposition,
  isWhatsappOptedOut,
  notifyUser,
} from "../lib/email";
import { normalizeWhatsappPhone } from "../lib/whatsapp-phone";
import { listWhatsappMessagesForLead } from "../lib/whatsapp-log";
import {
  notifyLeadNew,
  notifyLeadAssigned,
  notifyManagerNote,
} from "../lib/notify-triggers";
import {
  ensureAccountForLead,
  ensurePrimaryContact,
} from "../lib/accounts";
import { computeTaxes, ensureDealerTaxes } from "../lib/taxes";
import { activeDealerId, hasPermission } from "../middlewares/rbac";
import {
  checkLeadMutationOwnership,
  LEAD_NOT_OWNED,
} from "../lib/lead-ownership";
import {
  MIN_AGENT_CONFIDENCE,
  guardUntrusted,
  isAgentEnabled,
  recordAgentRun,
} from "../lib/agent-governance";
import { defaultDivisionId, divisionBelongsToDealer } from "./divisions";
import {
  ownerCalendarContact,
  testDriveCalendarFields,
} from "../lib/calendar";
import {
  enrichLegacySalesAdvisorPayload,
  resolveSalesAdvisorName,
  snapshotSalesAdvisorPayload,
} from "../lib/sales-advisor";
import { buildQuotePdf } from "../lib/quote-pdf";
import {
  approvedQuoteDiscountForLead,
  autoQuoteOnLeadCreated,
  autoQuoteOnLeadUpdated,
  generateQuoteForLead,
  quoteById,
  quotePdfPayload,
  withQuoteItems,
} from "../lib/quotes";
import { getChannelByDealerId } from "../lib/whatsapp-channel";
import {
  selectQuoteDownloadPayload,
  selectQuoteVersionOutboxPayload,
} from "../lib/quote-payload";
import { ensureLeadSources } from "../lib/lead-sources";
import { getActiveChecklist } from "../lib/stage-checklists";
import {
  dealerTimezone,
  formatDealerDate,
  formatDealerSlot,
  formatDealerTime,
  zonedAddDays,
  zonedDayKey,
  zonedParts,
  zonedStartOfDay,
  zonedTimeToUtc,
} from "../lib/timezone";
import {
  findBlockedEditField,
  redactHiddenFields,
} from "../lib/field-permissions";
import {
  afterTestDriveBooked,
  offeredSlotTimes,
  SLOT_LENGTH_MS,
  slotGridAligned,
  vehicleAvailabilityError,
} from "../lib/test-drive-scheduler";
import {
  capacityBlockedDays,
  isSlotBlocked,
  modelUnitIds,
} from "../lib/capacity-blocks";
import {
  ADVANCE_TARGET_PHASE,
  ADVANCE_STAGE_LABEL,
  PHASE_ORDER,
  REVIEW_STAGE_LABEL,
  CHECK_OWNER,
  buildStageChecks,
} from "../lib/stage-review";
import { computeLeadBrief } from "../lib/lead-brief";
import { runIntakeOrchestration } from "../lib/intake-orchestration";
import { autoAnalyzeCall } from "../lib/call-analysis";
import {
  scheduleCadenceAfterCall,
  completeCadenceTasks,
} from "../lib/call-cadence";
import {
  markLeadContactFromCall,
  withEffectiveContactDates,
} from "../lib/lead-contact";

const router: IRouter = Router();

/**
 * Ownership guard: Sales Advisors can SEE every lead in the dealership but
 * may only MUTATE leads assigned to them. Applies to every non-GET
 * /leads/:id... endpoint (PATCH, decision, advance, notes, calls, WhatsApp,
 * assign, …). Managers/coordinators/GM are unaffected. Missing leads fall
 * through so each route returns its own 404.
 */
router.use(async (req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    next();
    return;
  }
  const match = req.path.match(/^\/leads\/(\d+)(?:\/|$)/);
  if (!match) {
    next();
    return;
  }
  const verdict = await checkLeadMutationOwnership(
    res.locals.user,
    activeDealerId(res),
    Number(match[1]),
  );
  if (verdict === "forbidden") {
    res.status(403).json(LEAD_NOT_OWNED);
    return;
  }
  const suffix = req.path.replace(/^\/leads\/\d+/, "").replace(/\/$/, "");
  const protectedPatch = req.method === "PATCH" && suffix === "" &&
    ["phase", "status", "ownerUserId", "assignedTo", "purchaseType", "closureReason"].some((key) => key in (req.body ?? {}));
  const protectedAction = ["assign", "advance", "decision", "test-drive"].some((action) => suffix === `/${action}`);
  if (protectedPatch || protectedAction) {
    const [lead] = await db.select().from(leadsTable).where(and(
      eq(leadsTable.id, Number(match[1])), eq(leadsTable.dealerId, activeDealerId(res)),
    ));
    if (lead && isActiveCallCentreLead(lead)) {
      res.status(409).json({ error: "Record the call-centre outcome before changing ownership or advancing this lead", code: "call_centre_qualification_required" });
      return;
    }
  }
  next(); // "missing" falls through: route's own lookup produces the 404
});

router.post("/leads/:id/call-centre-disposition", async (req, res): Promise<void> => {
  const params = GetLeadParams.safeParse(req.params);
  const body = RecordCallCentreDispositionBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid call-centre outcome, notes, or date" });
    return;
  }
  try {
    const lead = await recordCallCentreDisposition(activeDealerId(res), params.data.id, res.locals.user!, body.data);
    if (lead.callCentreStatus === "transferred") notifyLeadAssigned(lead);
    res.json(GetLeadResponse.parse(lead));
  } catch (err) {
    if (err instanceof CallCentreError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});

async function logLeadEvent(
  lead: Lead,
  kind: string,
  title: string,
  detail: string | null,
  actor: string,
  isAgent = false,
): Promise<void> {
  await db.insert(timelineEventsTable).values({
    dealerId: lead.dealerId,
    customerId: lead.customerId,
    domain: "leads",
    kind,
    title,
    detail,
    actor,
    isAgent,
    refType: "lead",
    refId: lead.id,
  });
}

async function withLeadVehicleInterests<T extends Lead>(leads: T[]): Promise<Array<T & { vehicleInterests: Array<{
  vehicleId: number | null; make: string; model: string; modelYear: number;
  variant: string | null; color: string | null; unitPrice: number;
  quantity: number; position: number;
}> }>> {
  if (!leads.length) return [];
  const dealerId = leads[0]!.dealerId;
  const interests = await db.select({
    leadId: leadVehicleInterestsTable.leadId,
    vehicleId: leadVehicleInterestsTable.vehicleId,
    make: leadVehicleInterestsTable.make,
    model: leadVehicleInterestsTable.model,
    modelYear: leadVehicleInterestsTable.modelYear,
    variant: leadVehicleInterestsTable.variant,
    color: leadVehicleInterestsTable.color,
    unitPrice: leadVehicleInterestsTable.unitPrice,
    quantity: leadVehicleInterestsTable.quantity,
    position: leadVehicleInterestsTable.position,
  }).from(leadVehicleInterestsTable).where(and(
    eq(leadVehicleInterestsTable.dealerId, dealerId),
    inArray(leadVehicleInterestsTable.leadId, leads.map((lead) => lead.id)),
  )).orderBy(leadVehicleInterestsTable.position);
  const byLead = new Map<number, Array<Omit<typeof interests[number], "leadId">>>();
  for (const interest of interests) {
    const items = byLead.get(interest.leadId) ?? [];
    const { leadId: _leadId, ...item } = interest;
    items.push(item);
    byLead.set(interest.leadId, items);
  }
  return leads.map((lead) => ({ ...lead, vehicleInterests: byLead.get(lead.id) ?? [] }));
}

async function vehicleLabel(
  dealerId: number,
  id: number | null,
): Promise<string | null> {
  if (!id) return null;
  const [v] = await db
    .select()
    .from(vehiclesTable)
    .where(and(eq(vehiclesTable.id, id), eq(vehiclesTable.dealerId, dealerId)));
  return v ? `${v.year} ${v.make} ${v.model}` : null;
}

function actorName(res: {
  locals: { user?: { name: string | null; email: string | null } };
}): string {
  return res.locals.user?.name ?? res.locals.user?.email ?? "Staff";
}

router.get("/leads", async (req, res): Promise<void> => {
  const query = ListLeadsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const dealerId = activeDealerId(res);
  const filters: SQL[] = [eq(leadsTable.dealerId, dealerId)];
  // Soft delete (R4.8): default reads exclude deleted rows.
  if (!query.data.includeDeleted) filters.push(isNull(leadsTable.deletedAt));
  if (query.data.divisionId)
    filters.push(eq(leadsTable.divisionId, query.data.divisionId));
  if (query.data.phase) filters.push(eq(leadsTable.phase, query.data.phase));
  if (query.data.status) filters.push(eq(leadsTable.status, query.data.status));
  const listTz = await dealerTimezone(dealerId);
  if ((query.data as any).createdFrom) {
    const raw = (query.data as any).createdFrom;
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      // Dealer-local start of the requested day.
      filters.push(gte(leadsTable.createdAt, zonedStartOfDay(raw, listTz)));
    }
  }
  if ((query.data as any).createdTo) {
    const raw = (query.data as any).createdTo;
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      // Dealer-local next-day boundary, exclusive.
      const [y, m, d] = raw.split("-").map(Number);
      const nextKey = zonedAddDays(
        zonedTimeToUtc(listTz, y!, m!, d!, 12),
        listTz,
        1,
      );
      filters.push(
        sql`${leadsTable.createdAt} < ${zonedStartOfDay(nextKey, listTz)}`,
      );
    }
  }

  // RBAC visibility: every role with leads:view sees the full dealer
  // pipeline (Sales Advisors included — they browse everything but may only
  // MUTATE leads assigned to them; see the ownership guard below).
  const user = res.locals.user;

  const rows = await db
    .select()
    .from(leadsTable)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(leadsTable.aiScore), desc(leadsTable.createdAt));

  const effectiveRows = await withEffectiveContactDates(dealerId, rows);
  const withInterests = await withLeadVehicleInterests(effectiveRows);
  const visible = await redactHiddenFields(user, "leads", withInterests);
  res.json(ListLeadsResponse.parse(visible));
});

// NOTE: must be declared before /leads/:id so "sources" isn't parsed as an id.
router.get("/leads/sources", async (req, res): Promise<void> => {
  const query = ListLeadSourcesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const rows = await ensureLeadSources(activeDealerId(res));
  const result = query.data.includeInactive ? rows : rows.filter((r) => r.active);
  res.json(ListLeadSourcesResponse.parse(result));
});

// NOTE: must be declared before /leads/:id so "advisors" isn't parsed as an id.
router.get("/leads/advisors", async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
      roleName: rolesTable.name,
    })
    .from(dealerUsersTable)
    .innerJoin(usersTable, eq(dealerUsersTable.userId, usersTable.id))
    .leftJoin(rolesTable, eq(dealerUsersTable.roleId, rolesTable.id))
    .where(
      and(
        eq(dealerUsersTable.dealerId, activeDealerId(res)),
        eq(usersTable.status, "active"),
      ),
    );

  const assignable = rows
    .filter(
      (r) =>
        r.roleName === "Sales Advisor" ||
        r.roleName === "Sales Manager" ||
        r.roleName === "General Manager",
    )
    .map((r) => ({
      id: r.id,
      name: r.name ?? r.email ?? `User #${r.id}`,
      email: r.email,
      roleName: r.roleName,
    }));

  res.json(ListLeadAdvisorsResponse.parse(assignable));
});

router.post("/leads", async (req, res): Promise<void> => {
  if (Array.isArray(req.body?.vehicleInterests) && req.body.vehicleInterests.some(
    (interest: unknown) => typeof interest === "object" && interest !== null &&
      (interest as { vehicleId?: unknown }).vehicleId != null,
  )) {
    res.status(422).json({ error: "vehicleInterests must not contain vehicleId; physical units are assigned only at deal allocation." });
    return;
  }
  const parsed = CreateLeadBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const dealerId = activeDealerId(res);
  if (parsed.data.interestedVehicleId != null) {
    res.status(422).json({ error: "Physical vehicle selection is not allowed; submit vehicleInterests specifications." });
    return;
  }
  const { vehicleInterests, ...leadData } = parsed.data;
  let normalizedInterests = vehicleInterests
    ? [...vehicleInterests].sort((a, b) => a.position - b.position)
    : [];
  if (
    vehicleInterests &&
    new Set(vehicleInterests.map((interest) =>
      [interest.make, interest.model, interest.modelYear, interest.variant ?? "", interest.color ?? ""]
        .join("|").toLocaleLowerCase(),
    )).size !==
      vehicleInterests.length
  ) {
    res.status(422).json({
      error: "duplicate_vehicle_interests",
      detail: "Each vehicle specification may appear only once in vehicleInterests",
    });
    return;
  }
  let divisionId = parsed.data.divisionId ?? null;
  if (
    divisionId != null &&
    !(await divisionBelongsToDealer(divisionId, dealerId))
  ) {
    res.status(404).json({ error: "Division not found" });
    return;
  }
  if (divisionId == null) divisionId = await defaultDivisionId(dealerId);

  // Social sources require a sub-platform; validated against the dealer's
  // configured source list (unknown codes from intake agents pass through).
  if (parsed.data.source) {
    const sources = await ensureLeadSources(dealerId);
    const cfg = sources.find((s) => s.code === parsed.data.source);
    if (cfg?.isSocial && !parsed.data.sourceDetail) {
      res.status(422).json({
        error: `Source "${cfg.name}" is a social channel — pick the sub-platform (${SOCIAL_SUB_PLATFORMS.join(", ")})`,
      });
      return;
    }
  }

  // Dedup agent (A1): a matching open lead absorbs this enquiry instead of
  // spawning a duplicate record.
  const duplicate = await findOpenDuplicate(dealerId, parsed.data);
  if (duplicate) {
    const { lead, notice } = await mergeIntoExistingLead(
      duplicate,
      parsed.data,
      actorName(res),
    );
    res
      .status(201)
      .json(
        CreateLeadResponse.parse({ lead, merged: true, mergeNotice: notice }),
      );
    return;
  }

  const lead = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(leadsTable)
      .values({
        ...leadData,
        // New canonical interests never project a physical unit onto the lead.
        ...(vehicleInterests ? { interestedVehicleId: null } : {}),
        divisionId,
        dealerId,
      })
      .returning();
    if (created && normalizedInterests.length) {
      await tx.insert(leadVehicleInterestsTable).values(
        normalizedInterests.map((interest, position) => ({
          dealerId,
          leadId: created.id,
          vehicleId: null,
          make: interest.make,
          model: interest.model,
          modelYear: interest.modelYear,
          variant: interest.variant,
          color: interest.color,
          unitPrice: interest.unitPrice,
          quantity: interest.quantity,
          position,
        })),
      );
    }
    return created;
  });

  const leadWithInterests = lead
    ? (await withLeadVehicleInterests([lead]))[0]!
    : lead;
  // Specification-backed leads receive the canonical generated quote from the
  // quote agent. The lifecycle trigger remains the welcome-email fallback only
  // for leads that have no vehicle interest yet.
  if (lead && normalizedInterests.length === 0) onLeadCreated(lead);
  // R6.2 #1 New Lead → division sales managers (In-App + Email).
  if (lead) notifyLeadNew(lead);

  await logLeadEvent(
    lead!,
    "lead_created",
    `Lead created: ${lead!.name}`,
    `Captured via ${lead!.source.replace("_", " ")} and added to the pipeline.`,
    actorName(res),
  );

  // Manual in-app creation: the lead stays with the logged-in staff member
  // who created it. Intake channels (email/social/web) don't pass through
  // this route and keep round-robin. Falls back to round-robin when the
  // creator isn't a dealer member (e.g. platform super admin).
  const creator = res.locals.user as
    | { id: number; name: string | null; email: string | null }
    | undefined;
  const assigned =
    (creator ? await assignLeadToCreator(lead!, creator) : null) ??
    (await autoAssignLead(lead!));

  // Quote agent (A3): auto-generate only after ownership is settled so the
  // queued advisor snapshot reflects the assigned owner.
  if (lead) autoQuoteOnLeadCreated(assigned ?? lead);

  // Intake agent: nearest showroom + WhatsApp quote share (fire-and-forget).
  runIntakeOrchestration(assigned ?? lead!);

  res.status(201).json(
    CreateLeadResponse.parse({
        lead: assigned ? (await withLeadVehicleInterests([assigned]))[0]! : leadWithInterests,
      merged: false,
      mergeNotice: null,
    }),
  );
});

router.get("/leads/:id", async (req, res): Promise<void> => {
  const params = GetLeadParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const dealerId = activeDealerId(res);

  const [lead] = await db
    .select()
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.id, params.data!.id),
        eq(leadsTable.dealerId, dealerId),
        isNull(leadsTable.deletedAt),
      ),
    );

  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }

  const effectiveLeads = await withEffectiveContactDates(dealerId, [lead]);
  const withInterests = await withLeadVehicleInterests(effectiveLeads);
  const [visible] = await redactHiddenFields(
    res.locals.user,
    "leads",
    withInterests,
  );
  res.json(GetLeadResponse.parse(visible));
});

router.get("/leads/:id/timeline", async (req, res): Promise<void> => {
  const params = GetLeadTimelineParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const rows = await db
    .select()
    .from(timelineEventsTable)
    .where(
      and(
        eq(timelineEventsTable.dealerId, activeDealerId(res)),
        eq(timelineEventsTable.refType, "lead"),
        eq(timelineEventsTable.refId, params.data.id),
        isNotNull(timelineEventsTable.refId),
      ),
    )
    .orderBy(desc(timelineEventsTable.createdAt))
    .limit(60);

  res.json(GetLeadTimelineResponse.parse(rows));
});

router.post("/leads/:id/notes", async (req, res): Promise<void> => {
  const params = CreateLeadNoteParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = CreateLeadNoteBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [lead] = await db
    .select()
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.id, params.data.id),
        eq(leadsTable.dealerId, activeDealerId(res)),
      ),
    );
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }

  const actor = res.locals.user?.name || res.locals.user?.email || "Staff";
  const [event] = await db
    .insert(timelineEventsTable)
    .values({
      dealerId: lead.dealerId,
      customerId: lead.customerId,
      domain: "leads",
      kind: "note",
      title: "Note added",
      detail: body.data.text,
      actor,
      isAgent: false,
      refType: "lead",
      refId: lead.id,
    })
    .returning();

  // R6.2 #15 Manager note → owning advisor (In-App), skipping self-notes.
  if (lead.ownerUserId && lead.ownerUserId !== res.locals.user?.id) {
    notifyManagerNote({
      dealerId: lead.dealerId,
      noteId: event!.id,
      advisorUserId: lead.ownerUserId,
      authorName: actor,
      excerpt: `${lead.name}: ${body.data.text.slice(0, 140)}`,
      link: `/pipeline/${lead.id}`,
    });
  }

  res.status(201).json(CreateLeadNoteResponse.parse(event));
});

router.post("/leads/:id/notify-owner", async (req, res): Promise<void> => {
  const params = NotifyLeadOwnerParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = NotifyLeadOwnerBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const dealerId = activeDealerId(res);
  const [lead] = await db
    .select()
    .from(leadsTable)
    .where(and(eq(leadsTable.id, params.data.id), eq(leadsTable.dealerId, dealerId)));
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }
  if (!lead.ownerUserId) {
    res.status(400).json({ error: "This lead has no assigned owner to notify" });
    return;
  }

  const sender =
    res.locals.user?.name || res.locals.user?.email || "A teammate";
  await notifyUser({
    userId: lead.ownerUserId,
    dealerId,
    type: "assignment",
    title: `Action needed on lead: ${lead.name}`,
    body: `${sender}: ${body.data.message.slice(0, 300)}`,
    link: `/lead/${lead.id}`,
  });

  res.json(NotifyLeadOwnerResponse.parse({ ok: true }));
});

router.post(
  "/leads/:id/send-test-drive-invite",
  async (req, res): Promise<void> => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid lead id" });
      return;
    }
    const dealerId = activeDealerId(res);
    const [lead] = await db
      .select()
      .from(leadsTable)
      .where(and(eq(leadsTable.id, id), eq(leadsTable.dealerId, dealerId)));
    if (!lead) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    const result = await sendTestDriveInviteEmail(lead);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({ ok: true });
  },
);

const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;
const waDigits = (s: string): string => normalizeWhatsappPhone(s) ?? "";

function replyWindow(rows: { direction: string; createdAt: Date }[]): {
  open: boolean;
  expiresAt: Date | null;
} {
  const lastInbound = [...rows]
    .reverse()
    .find((r) => r.direction === "in");
  if (!lastInbound) return { open: false, expiresAt: null };
  const expiresAt = new Date(lastInbound.createdAt.getTime() + REPLY_WINDOW_MS);
  return { open: expiresAt.getTime() > Date.now(), expiresAt };
}

router.get("/leads/:id/whatsapp", async (req, res): Promise<void> => {
  const params = GetLeadWhatsappThreadParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [lead] = await db
    .select()
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.id, params.data.id),
        eq(leadsTable.dealerId, activeDealerId(res)),
      ),
    );
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }

  const rows = await listWhatsappMessagesForLead(lead);
  const window = replyWindow(rows);
  const channel = await getChannelByDealerId(lead.dealerId);
  const configured = Boolean(channel);
  const templateAvailable = Boolean(channel?.serviceTemplateName);
  const transcriptPhone =
    rows.length > 0 ? rows[rows.length - 1]!.phone : waDigits(lead.phone ?? "");
  const optedOut = transcriptPhone
    ? await isWhatsappOptedOut(lead.dealerId, transcriptPhone)
    : false;
  let blocked: string | null = null;
  if (!transcriptPhone)
    blocked = "This lead has no valid WhatsApp number to message.";
  else if (!configured)
    blocked = "WhatsApp sending is not configured for this dealership.";
  else if (optedOut)
    blocked = "This customer opted out of WhatsApp. Ask them to send START before replying.";
  else if (!window.open && !templateAvailable)
    blocked =
      "The 24-hour reply window is closed and no approved service template is configured.";

  res.json(
    GetLeadWhatsappThreadResponse.parse({
      messages: rows.map((r) => ({
        id: r.id,
        direction: r.direction,
        body: r.body,
        actor: r.actor,
        deliveryStatus: r.deliveryStatus,
        deliveryError: r.deliveryError,
        createdAt: r.createdAt,
      })),
      canReply:
        Boolean(transcriptPhone) &&
        configured &&
        !optedOut &&
        (window.open || templateAvailable),
      replyBlockedReason: blocked,
      windowExpiresAt: window.expiresAt,
    }),
  );
});

router.post("/leads/:id/whatsapp", async (req, res): Promise<void> => {
  const params = SendLeadWhatsappReplyParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = SendLeadWhatsappReplyBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const [lead] = await db
    .select()
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.id, params.data.id),
        eq(leadsTable.dealerId, activeDealerId(res)),
      ),
    );
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }

  const rows = await listWhatsappMessagesForLead(lead);
  // Reply to the number the customer actually chats from (transcript phone),
  // falling back to the lead's stored mobile.
  const to = rows.length > 0 ? rows[rows.length - 1]!.phone : waDigits(lead.phone ?? "");
  if (!to) {
    res
      .status(422)
      .json({ error: "This lead has no WhatsApp number to reply to." });
    return;
  }
  const channel = await getChannelByDealerId(lead.dealerId);
  if (!channel) {
    res.status(422).json({
      error: "WhatsApp sending is not configured for this dealership.",
    });
    return;
  }
  const window = replyWindow(rows);
  if (await isWhatsappOptedOut(lead.dealerId, to)) {
    res.status(422).json({
      error:
        "This customer opted out of WhatsApp. Ask them to send START before replying.",
    });
    return;
  }
  if (!window.open && !channel.serviceTemplateName) {
    res.status(422).json({
      error:
        "The 24-hour reply window is closed and no approved service template is configured.",
    });
    return;
  }

  const actor = actorName(res);
  // Through the outbox: the worker delivers, retries with backoff, and
  // records the transcript row (with this actor) once actually sent.
  const queued = await enqueueWhatsapp({
    kind: "whatsapp_message",
    to,
    body: body.data.text,
    dealerId: lead.dealerId,
    leadId: lead.id,
    customerId: lead.customerId,
    summary: `Reply to ${lead.name}`,
    actor,
  });
  if (queued.status === "cancelled" || queued.status === "failed") {
    res.status(422).json({
      error: queued.lastError ?? "The WhatsApp reply could not be queued.",
    });
    return;
  }

  await logLeadEvent(
    lead,
    "whatsapp_message",
    `WhatsApp reply queued for ${lead.name}`,
    body.data.text,
    actor,
  );

  res.status(201).json(
    SendLeadWhatsappReplyResponse.parse({
      id: queued.id,
      direction: "out",
      body: body.data.text,
      actor,
      deliveryStatus: queued.deliveryStatus ?? "queued",
      deliveryError: queued.lastError,
      createdAt: queued.createdAt,
    }),
  );
});

// ---------------------------------------------------------------------------
// A7 — Customer Outreach: approve-and-send a drafted message. WhatsApp-first
// with email fallback; everything goes through the outbox and is logged as
// an A7 activity on the lead timeline.
// ---------------------------------------------------------------------------
router.post("/leads/:id/outreach", async (req, res): Promise<void> => {
  const params = SendLeadOutreachParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = SendLeadOutreachBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const [lead] = await db
    .select()
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.id, params.data.id),
        eq(leadsTable.dealerId, activeDealerId(res)),
      ),
    );
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }

  const phone = (lead.phone ?? "").replace(/\D/g, "");
  const email = lead.email?.trim() || null;

  // WhatsApp-first, email fallback — unless the advisor forced a channel.
  let channel: "whatsapp" | "email";
  if (body.data.channel) {
    channel = body.data.channel;
    if (channel === "whatsapp" && !phone) {
      res.status(422).json({ error: "This lead has no phone number for WhatsApp." });
      return;
    }
    if (channel === "email" && !email) {
      res.status(422).json({ error: "This lead has no email address." });
      return;
    }
  } else if (phone) {
    channel = "whatsapp";
  } else if (email) {
    channel = "email";
  } else {
    res.status(422).json({
      error: "This lead has no phone or email — add contact details first.",
    });
    return;
  }

  const actor = actorName(res);
  let outboxId: number;
  let recipient: string;
  if (channel === "whatsapp") {
    const queued = await enqueueWhatsapp({
      kind: "outreach",
      to: phone,
      body: body.data.message,
      dealerId: lead.dealerId,
      leadId: lead.id,
      customerId: lead.customerId,
      summary: `Outreach to ${lead.name}`,
      actor,
    });
    outboxId = queued.id;
    recipient = phone;
  } else {
    const queued = await enqueueEmail({
      template: "outreach",
      to: email!,
      dealerId: lead.dealerId,
      customerId: lead.customerId,
      leadId: lead.id,
      data: {
        name: lead.name,
        advisor: actor,
        message: body.data.message,
        ...(body.data.subject ? { subject: body.data.subject } : {}),
      },
    });
    outboxId = queued.id;
    recipient = email!;
  }

  // A7 activity: timeline + agent activity feed.
  await logLeadEvent(
    lead,
    "outreach_sent",
    `Outreach ${channel === "whatsapp" ? "WhatsApp" : "email"} approved & queued`,
    body.data.message,
    actor,
    true,
  );
  try {
    const [agent] = await db
      .select()
      .from(agentsTable)
      .where(
        and(
          eq(agentsTable.dealerId, lead.dealerId),
          eq(agentsTable.key, "A7"),
        ),
      );
    if (agent) {
      await db.insert(timelineEventsTable).values({
        dealerId: lead.dealerId,
        customerId: lead.customerId,
        domain: "agents",
        kind: "agent_activity",
        title: `A7 outreach ${channel} queued for ${lead.name}`,
        detail: body.data.message.slice(0, 280),
        actor,
        isAgent: true,
        refType: "lead",
        refId: lead.id,
      });
    }
  } catch (err) {
    req.log.error({ err }, "failed to record A7 activity");
  }

  res.status(201).json(
    SendLeadOutreachResponse.parse({
      ok: true,
      channel,
      outboxId,
      recipient,
    }),
  );
});

/** Quote metadata shared by the info + PDF routes. */
async function leadQuoteContext(
  leadId: number,
  dealerId: number,
): Promise<{
  lead: Lead;
  vehicle: typeof vehiclesTable.$inferSelect | null;
  quoteRef: string;
  sentPayload: Record<string, string> | null;
  canonicalPayload: Record<string, string> | null;
  sentAt: Date | null;
} | null> {
  const [lead] = await db
    .select()
    .from(leadsTable)
    .where(and(eq(leadsTable.id, leadId), eq(leadsTable.dealerId, dealerId)));
  if (!lead) return null;

  const [vehicle] = lead.interestedVehicleId
    ? await db
        .select()
        .from(vehiclesTable)
        .where(
          and(
            eq(vehiclesTable.id, lead.interestedVehicleId),
            eq(vehiclesTable.dealerId, dealerId),
          ),
        )
    : [];

  // The emailed quote (if any) — its payload lets us regenerate the exact PDF.
  const [log] = await db
    .select()
    .from(emailLogsTable)
    .where(
      and(
        eq(emailLogsTable.dealerId, dealerId),
        eq(emailLogsTable.template, "vehicle_quote"),
        or(
          // Canonical queues persist the trusted lead identity in the column
          // and payload; older queues predate those fields and retain the
          // Q-<lead>-... reference as their only legacy identity.
          eq(emailLogsTable.leadId, leadId),
          sql`${emailLogsTable.payload} ->> 'leadId' = ${String(leadId)}`,
          sql`${emailLogsTable.payload} ->> 'quoteRef' LIKE ${`Q-${leadId}-%`}`,
        ),
      ),
    )
    .orderBy(desc(emailLogsTable.id))
    .limit(1);

  // New queues always carry the advisor snapshot, including an empty string.
  // Only historical payloads without that key may be enriched, and only from
  // the lead already authorized by this dealer-scoped lookup. This preserves
  // replay semantics when an owner was assigned or renamed later.
  let sentPayload = log?.payload ? { ...log.payload } : null;
  if (
    sentPayload &&
    !Object.prototype.hasOwnProperty.call(sentPayload, "salesAdvisorName")
  ) {
    sentPayload = enrichLegacySalesAdvisorPayload(
      sentPayload,
      await resolveSalesAdvisorName(lead),
    );
  }

  // A canonical lead may have no legacy inventory pointer: its immutable
  // saved quote is still the correct historical source for the main
  // quote.pdf route when no queued payload can be replayed. A current
  // inventory pointer must never replace an existing historical snapshot.
  let canonicalPayload: Record<string, string> | null = null;
  if (!sentPayload) {
    const [savedQuote] = await db
      .select()
      .from(quotesTable)
      .where(
        and(
          eq(quotesTable.dealerId, dealerId),
          eq(quotesTable.leadId, leadId),
        ),
      )
      .orderBy(desc(quotesTable.version), desc(quotesTable.id))
      .limit(1);
    if (savedQuote) {
      canonicalPayload = await quotePdfPayload(savedQuote, lead);
    }
  }

  // Fresh (never-emailed) quotes are dated today so validity isn't already expired.
  const today = zonedParts(new Date(), await dealerTimezone(dealerId));
  const fallbackRef = `Q-${lead.id}-${today.year}${String(today.month).padStart(2, "0")}${String(today.day).padStart(2, "0")}`;

  return {
    lead,
    vehicle: vehicle ?? null,
    quoteRef:
      sentPayload?.quoteRef ??
      canonicalPayload?.quoteRef ??
      fallbackRef,
    sentPayload,
    canonicalPayload,
    sentAt: log?.sentAt ?? null,
  };
}

const quoteMoney = (n: number) =>
  `GY$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

/** Build a fresh quote payload from inventory when no emailed quote exists. */
async function freshQuotePayload(
  lead: Lead,
  vehicle: typeof vehiclesTable.$inferSelect,
  quoteRef: string,
  tz: string,
): Promise<Record<string, string>> {
  const issued = new Date();
  const validUntil = new Date(issued.getTime() + 30 * 24 * 60 * 60 * 1000);
  return snapshotSalesAdvisorPayload({
    name: lead.name,
    vehicle: `${vehicle.year} ${vehicle.make} ${vehicle.model}`,
    model: vehicle.model,
    version:
      vehicle.trim || vehicle.variant || lead.variant || "Standard specification",
    color: vehicle.exteriorColor || lead.color || "",
    quantity: "1",
    unitPrice: quoteMoney(vehicle.price),
    total: quoteMoney(vehicle.price),
    quoteRef,
    issuedOn: formatDealerDate(issued, tz),
    validUntil: formatDealerDate(validUntil, tz),
  }, await resolveSalesAdvisorName(lead));
}

async function queuedQuoteVersionPayload(
  dealerId: number,
  leadId: number,
  quote: { id: number; quoteNumber: string; version: number },
): Promise<Record<string, string> | null> {
  const quoteRef = `${quote.quoteNumber}-R${quote.version}`;
  const nestedLeadId = String(leadId);
  const nestedQuoteId = String(quote.id);
  const logs = await db
    .select({
      dealerId: emailLogsTable.dealerId,
      leadId: emailLogsTable.leadId,
      channel: emailLogsTable.channel,
      template: emailLogsTable.template,
      payload: emailLogsTable.payload,
    })
    .from(emailLogsTable)
    .where(
      and(
        eq(emailLogsTable.dealerId, dealerId),
        or(
          and(
            eq(emailLogsTable.channel, "email"),
            eq(emailLogsTable.template, "vehicle_quote"),
          ),
          eq(emailLogsTable.channel, "whatsapp"),
        ),
        // Keep the database result set scoped to this dealer, lead and
        // revision. The pure selector below rechecks every identity after
        // decoding the WhatsApp document payload.
        or(
          eq(emailLogsTable.leadId, leadId),
          sql`${emailLogsTable.payload} ->> 'leadId' = ${nestedLeadId}`,
          sql`${emailLogsTable.payload} ->> 'documentDataJson' LIKE ${`%"leadId":"${nestedLeadId}"%`}`,
          sql`${emailLogsTable.payload} ->> 'documentDataJson' LIKE ${`%"leadId":${nestedLeadId}%`}`,
        ),
        or(
          sql`${emailLogsTable.payload} ->> 'quoteId' = ${nestedQuoteId}`,
          sql`${emailLogsTable.payload} ->> 'quoteRef' = ${quoteRef}`,
          sql`${emailLogsTable.payload} ->> 'documentDataJson' LIKE ${`%"quoteId":"${nestedQuoteId}"%`}`,
          sql`${emailLogsTable.payload} ->> 'documentDataJson' LIKE ${`%"quoteId":${nestedQuoteId}%`}`,
          sql`${emailLogsTable.payload} ->> 'documentDataJson' LIKE ${`%"quoteRef":"${quoteRef}"%`}`,
        ),
      ),
    )
    .orderBy(desc(emailLogsTable.id));

  return selectQuoteVersionOutboxPayload(logs, {
    dealerId,
    leadId,
    quoteId: quote.id,
    quoteRef,
  });
}

router.get("/leads/:id/quote", async (req, res): Promise<void> => {
  const params = GetLeadQuoteParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const ctx = await leadQuoteContext(params.data.id, activeDealerId(res));
  if (!ctx) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }

  if (!ctx.vehicle && !ctx.sentPayload && !ctx.canonicalPayload) {
    res.json(GetLeadQuoteResponse.parse({ available: false }));
    return;
  }

  const payload =
    selectQuoteDownloadPayload(
      ctx.sentPayload,
      ctx.canonicalPayload,
      ctx.vehicle
        ? await freshQuotePayload(
            ctx.lead,
            ctx.vehicle,
            ctx.quoteRef,
            await dealerTimezone(ctx.lead.dealerId),
          )
        : null,
    ) ?? {};
  res.json(
    GetLeadQuoteResponse.parse({
      available: true,
      quoteRef: ctx.quoteRef,
      fileName: `${ctx.lead.name} - ${ctx.quoteRef}.pdf`,
      vehicle: payload.vehicle ?? null,
      issuedOn: payload.issuedOn ?? null,
      sentAt: ctx.sentAt?.toISOString() ?? null,
    }),
  );
});

router.get("/leads/:id/quote.pdf", async (req, res): Promise<void> => {
  const params = DownloadLeadQuotePdfParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const ctx = await leadQuoteContext(params.data.id, activeDealerId(res));
  if (!ctx) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }

  const payload = selectQuoteDownloadPayload(
    ctx.sentPayload,
    ctx.canonicalPayload,
    ctx.vehicle
      ? await freshQuotePayload(
          ctx.lead,
          ctx.vehicle,
          ctx.quoteRef,
          await dealerTimezone(ctx.lead.dealerId),
        )
      : null,
  );
  if (!payload) {
    res
      .status(404)
      .json({ error: "No vehicle of interest on file — no quote available" });
    return;
  }

  if (!payload.dealerName) {
    const [dealer] = await db
      .select({ name: dealersTable.name, brandName: dealersTable.brandName, city: dealersTable.city, country: dealersTable.country })
      .from(dealersTable)
      .where(eq(dealersTable.id, ctx.lead.dealerId))
      .limit(1);
    if (dealer) {
      payload.dealerName = dealer.brandName ?? dealer.name;
      payload.dealerAddress = [dealer.city, dealer.country]
        .filter(Boolean)
        .join(", ");
    }
  }
  const pdf = await buildQuotePdf(
    payload,
    await dealerTimezone(ctx.lead.dealerId),
    (await getDealerPdfBranding(ctx.lead.dealerId)).logo,
  );
  const safeName = `${ctx.lead.name} - ${ctx.quoteRef}.pdf`.replace(
    /[^\w .-]+/g,
    "",
  );
  res
    .setHeader("Content-Type", "application/pdf")
    .setHeader("Content-Disposition", `inline; filename="${safeName}"`)
    .send(pdf);
});

// ————— Quotation "Codes" (versioned, deterministic tax engine) —————
// (leadForDealer helper is declared further down with the call-log routes.)

router.get("/leads/:id/quotes", async (req, res): Promise<void> => {
  const params = ListLeadQuotesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const lead = await leadForDealer(params.data.id, activeDealerId(res));
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }
  const rows = await db
    .select()
    .from(quotesTable)
    .where(
      and(
        eq(quotesTable.dealerId, lead.dealerId),
        eq(quotesTable.leadId, lead.id),
      ),
    )
    .orderBy(desc(quotesTable.version));
  res.json(ListLeadQuotesResponse.parse(await withQuoteItems(rows)));
});

router.post("/leads/:id/quotes", async (req, res): Promise<void> => {
  const params = GenerateLeadQuoteParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = GenerateLeadQuoteBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const lead = await leadForDealer(params.data.id, activeDealerId(res));
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }
  const quote = await generateQuoteForLead(lead, {
    actor: actorName(res),
    isAgent: false,
    trigger: "manual",
    overrides: {
      modelName: body.data.modelName,
      modelYear: body.data.modelYear,
    },
  });
  if (!quote) {
    res.status(422).json({
      error:
        "This lead has no vehicle of interest on file — pick a vehicle first, then generate the Code.",
    });
    return;
  }
  res.status(201).json(GenerateLeadQuoteResponse.parse((await withQuoteItems([quote]))[0]));
});

// Advisor requests a discount on the current quote; a manager gate must
// approve it before it applies to the quote total.
router.post(
  "/leads/:id/quotes/discount-request",
  async (req, res): Promise<void> => {
    const params = RequestQuoteDiscountParams.safeParse(req.params);
    const body = RequestQuoteDiscountBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({
        error: (params.success ? body : params).error?.message ?? "Invalid",
      });
      return;
    }
    const lead = await leadForDealer(params.data.id, activeDealerId(res));
    if (!lead) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    const [quote] = await db
      .select()
      .from(quotesTable)
      .where(
        and(
          eq(quotesTable.dealerId, lead.dealerId),
          eq(quotesTable.leadId, lead.id),
          eq(quotesTable.status, "current"),
        ),
      )
      .orderBy(desc(quotesTable.version))
      .limit(1);
    if (!quote) {
      res.status(404).json({
        error: "No current quote on this lead — generate the Code first.",
      });
      return;
    }
    const requestType = body.data.requestType ?? "discount";
    if (requestType === "discount" && quote.discountStatus === "pending") {
      res.status(409).json({
        error:
          "A discount request is already pending management approval on this quote.",
      });
      return;
    }
    if (requestType === "duty_free" && quote.dutyFreeStatus === "pending") {
      res.status(409).json({ error: "A duty-free request is already pending management approval on this quote." });
      return;
    }
    const amount = body.data.amount ?? 0;
    if (requestType === "discount" && (!body.data.amount || amount >= quote.total)) {
      res.status(422).json({
        error: `Discount must be less than the quote total (GY$${quote.total.toLocaleString("en-US")}).`,
      });
      return;
    }
    const actor = actorName(res);
    const [quoteImage] = await db
      .select({ id: documentsTable.id, fileName: documentsTable.fileName })
      .from(documentsTable)
      .where(and(
        eq(documentsTable.dealerId, lead.dealerId),
        eq(documentsTable.entityType, "quote"),
        eq(documentsTable.entityId, quote.id),
        eq(documentsTable.type, "quote"),
      ))
      .orderBy(desc(documentsTable.version), desc(documentsTable.id))
      .limit(1);
    // Gate insert + quote flag flip run in ONE transaction with a
    // compare-and-set on discountStatus, so two concurrent requests can't
    // both create pending gates for the same quote.
    let gate: typeof gatesTable.$inferSelect | undefined;
    let updated: typeof quotesTable.$inferSelect | undefined;
    try {
      await db.transaction(async (tx) => {
        const [g] = await tx
          .insert(gatesTable)
          .values({
        dealerId: lead.dealerId,
        type: requestType === "duty_free" ? "quote_duty_free" : "quote_discount",
        status: "pending",
        priority: "normal",
        customerId: lead.customerId ?? null,
        customerName: lead.name,
        refType: "quote",
        refId: quote.id,
        amount: requestType === "duty_free" ? quote.total : amount,
        title: `${requestType === "duty_free" ? "Duty-free quote" : "Quote discount"} approval — ${lead.name}`,
        summary:
          requestType === "duty_free"
            ? `${actor} requested duty-free treatment for ${quote.quoteNumber} rev ${quote.version}. Reason: ${body.data.reason}`
            : `${actor} requested a GY$${amount.toLocaleString("en-US")} discount on ${quote.quoteNumber} rev ${quote.version} (total GY$${quote.total.toLocaleString("en-US")}). Reason: ${body.data.reason}`,
        evidence: [
          { label: "Quote", value: `${quote.quoteNumber}-R${quote.version}` },
          {
            label: "Quote total",
            value: `GY$${quote.total.toLocaleString("en-US")}`,
          },
          ...(requestType === "discount" ? [{
            label: "Requested discount",
            value: `GY$${amount.toLocaleString("en-US")}`,
          }] : []),
          { label: "Requested by", value: actor },
          { label: "Reason", value: body.data.reason },
          ...(quoteImage
            ? [
                { label: "Quote image", value: quoteImage.fileName },
                { label: "Quote image document", value: String(quoteImage.id) },
              ]
            : []),
        ],
          })
          .returning();
        gate = g;
        // CAS: only flip to pending if it isn't already pending — a
        // concurrent request that won the race makes this update match
        // zero rows and the whole transaction rolls back.
        const [u] = await tx
          .update(quotesTable)
          .set(requestType === "duty_free" ? {
            requestType: "duty_free", dutyFreeStatus: "pending",
            dutyFreeReason: body.data.reason, dutyFreeRequestedBy: actor, dutyFreeGateId: g?.id ?? null,
          } : {
            discountStatus: "pending", discountRequestedAmount: amount,
            discountReason: body.data.reason, discountRequestedBy: actor, discountGateId: g?.id ?? null,
          })
          .where(
            and(
              eq(quotesTable.id, quote.id),
              eq(quotesTable.dealerId, lead.dealerId),
              eq(quotesTable.status, "current"),
              ...(requestType === "duty_free"
                ? [ne(quotesTable.dutyFreeStatus, "pending")]
                : [ne(quotesTable.discountStatus, "pending")]),
            ),
          )
          .returning();
        if (!u) throw new Error("DISCOUNT_RACE");
        updated = u;
      });
    } catch (err) {
      if (err instanceof Error && err.message === "DISCOUNT_RACE") {
        res.status(409).json({
          error:
            "A discount request is already pending management approval on this quote.",
        });
        return;
      }
      throw err;
    }
    await db.insert(timelineEventsTable).values({
      dealerId: lead.dealerId,
      customerId: lead.customerId,
      domain: "leads",
      kind: requestType === "duty_free" ? "quote_duty_free_requested" : "quote_discount_requested",
      title: `${requestType === "duty_free" ? "Duty Free" : "Discount"} requested on ${quote.quoteNumber}`,
      detail:
        requestType === "duty_free"
          ? `Duty Free treatment requested for rev ${quote.version} — pending management approval. Reason: ${body.data.reason}`
          : `GY$${amount.toLocaleString("en-US")} off rev ${quote.version} — pending management approval. Reason: ${body.data.reason}`,
      actor,
      refType: "lead",
      refId: lead.id,
    });
    res.json(RequestQuoteDiscountResponse.parse(updated));
  },
);

router.get(
  "/leads/:id/quotes/:quoteId/pdf",
  async (req, res): Promise<void> => {
    const params = DownloadLeadQuoteVersionPdfParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const lead = await leadForDealer(params.data.id, activeDealerId(res));
    if (!lead) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    const quote = await quoteById(lead.dealerId, lead.id, params.data.quoteId);
    if (!quote) {
      res.status(404).json({ error: "Quote not found" });
      return;
    }
    const [quoteImage] = await db
      .select()
      .from(documentsTable)
      .where(and(
        eq(documentsTable.dealerId, lead.dealerId),
        eq(documentsTable.entityType, "quote"),
        eq(documentsTable.entityId, quote.id),
        eq(documentsTable.type, "quote"),
        sql`${documentsTable.mimeType} in ('image/jpeg', 'image/jpg', 'image/png')`,
      ))
      .orderBy(desc(documentsTable.version), desc(documentsTable.id))
      .limit(1);
    let attachment: { data: Buffer; fileName: string } | null = null;
    if (quoteImage?.storageKey) {
      const storage = new ObjectStorageService();
      const file = await storage.getObjectEntityFile(quoteImage.storageKey);
      const [data] = await file.download();
      attachment = { data, fileName: quoteImage.fileName };
    }
    const queuedPayload = await queuedQuoteVersionPayload(
      lead.dealerId,
      lead.id,
      quote,
    );
    const historicalPayload = queuedPayload
      ? Object.prototype.hasOwnProperty.call(
          queuedPayload,
          "salesAdvisorName",
        )
        ? queuedPayload
        : enrichLegacySalesAdvisorPayload(
            queuedPayload,
            await resolveSalesAdvisorName(lead),
          )
      : await quotePdfPayload(quote, lead);
    const pdf = await buildQuotePdf(
      historicalPayload,
      await dealerTimezone(lead.dealerId),
      (await getDealerPdfBranding(lead.dealerId)).logo,
      attachment,
    );
    const safeName =
      `${quote.customerName} - ${quote.quoteNumber}-R${quote.version}.pdf`.replace(
        /[^\w .-]+/g,
        "",
      );
    res
      .setHeader("Content-Type", "application/pdf")
      .setHeader("Content-Disposition", `inline; filename="${safeName}"`)
      .send(pdf);
  },
);

router.post(
  "/leads/:id/quotes/:quoteId/send",
  async (req, res): Promise<void> => {
    const params = SendLeadQuoteParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const body = SendLeadQuoteBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    const lead = await leadForDealer(params.data.id, activeDealerId(res));
    if (!lead) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    const quote = await quoteById(lead.dealerId, lead.id, params.data.quoteId);
    if (!quote) {
      res.status(404).json({ error: "Quote not found" });
      return;
    }
    if (quote.status === "superseded") {
      res.status(410).json({
        error:
          "This Code has been superseded by a newer revision — send the current one instead.",
      });
      return;
    }

    const channel = body.data.channel;
    const emailRequested = channel === "email" || channel === "both";
    const whatsappRequested = channel === "whatsapp" || channel === "both";
    const quotePayload = {
      ...(await quotePdfPayload(quote, lead)),
      quoteId: String(quote.id),
      leadId: String(lead.id),
    };
    let emailQueued = false;
    let whatsappStatus:
      | "not_requested"
      | "queued"
      | "already_sent"
      | "blocked" =
      whatsappRequested ? "blocked" : "not_requested";
    let whatsappBlockedReason: string | null = null;

    if (emailRequested) {
      if (!lead.email) {
        res
          .status(422)
          .json({ error: "This lead has no email address on file." });
        return;
      }
      // Rides the existing vehicle_quote path — branded email + PDF attachment.
      await enqueueEmail({
        template: "vehicle_quote",
        to: lead.email,
        dealerId: lead.dealerId,
        customerId: lead.customerId,
        leadId: lead.id,
        data: quotePayload,
      });
      emailQueued = true;
    }

    if (whatsappRequested) {
      const to = waDigits(lead.phone ?? "");
      if (!to) {
        whatsappBlockedReason =
          "This lead has no phone number for WhatsApp.";
      } else {
        const whatsappChannel = await getChannelByDealerId(lead.dealerId);
        if (!whatsappChannel) {
          whatsappBlockedReason =
            "WhatsApp sending is not configured for this dealership.";
        } else {
          const taxText =
            quote.taxLines.length > 0
              ? quote.taxLines
                  .map(
                    (line) =>
                      `• ${line.name}: GY$${line.amount.toLocaleString("en-US")}`,
                  )
                  .join("\n")
              : "• No taxes applicable";
          const text =
            `Hi ${quote.customerName}, your estimate ${quote.quoteNumber} (rev ${quote.version}) from AURA is attached as a PDF.\n\n` +
            `${quote.modelYear} ${quote.vehicleLine}${quote.color ? ` — ${quote.color}` : ""}\n` +
            `Base price: GY$${quote.basePrice.toLocaleString("en-US")}\n${taxText}\n` +
            `Total: GY$${quote.total.toLocaleString("en-US")}\n\n` +
            `Valid until ${quote.validUntil}. Reply here with any questions!`;
          const queued = await enqueueWhatsapp({
            kind: "whatsapp_message",
            to,
            body: text,
            dealerId: lead.dealerId,
            leadId: lead.id,
            customerId: lead.customerId,
            summary: `Quote PDF ${quote.quoteNumber} for ${lead.name}`,
            actor: actorName(res),
            document: {
              kind: "quote_pdf",
              filename: `${quote.quoteNumber}-R${quote.version}.pdf`.replace(
                /[^A-Za-z0-9_.-]/g,
                "",
              ),
              data: quotePayload,
            },
            dedupeKey: `lead:${lead.id}:quote:${quote.id}:whatsapp-document:v1`,
          });
          const disposition = whatsappOutboxDisposition(queued);
          if (disposition === "blocked") {
            whatsappBlockedReason =
              queued.lastError ??
              "The quote PDF could not be sent on WhatsApp.";
          } else {
            whatsappStatus = disposition;
          }
        }
      }

      if (channel === "whatsapp" && whatsappStatus === "blocked") {
        res.status(422).json({
          error:
            whatsappBlockedReason ??
            "The quote PDF could not be sent on WhatsApp.",
        });
        return;
      }
    }

    res.json(
      SendLeadQuoteResponse.parse({
        ok: true,
        channel,
        emailQueued,
        whatsappStatus,
        whatsappBlockedReason,
      }),
    );
  },
);

router.post("/leads/:id/assign", async (req, res): Promise<void> => {
  const params = AssignLeadParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = AssignLeadBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [existing] = await db
    .select()
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.id, params.data.id),
        eq(leadsTable.dealerId, activeDealerId(res)),
      ),
    );
  if (!existing) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }

  const [advisor] = await db
    .select({ user: usersTable })
    .from(dealerUsersTable)
    .innerJoin(usersTable, eq(dealerUsersTable.userId, usersTable.id))
    .where(
      and(
        eq(dealerUsersTable.dealerId, activeDealerId(res)),
        eq(dealerUsersTable.userId, parsed.data.userId),
      ),
    )
    .then((rows) => rows.map((r) => r.user));
  if (!advisor) {
    res.status(404).json({ error: "Advisor not found" });
    return;
  }
  const advisorName = advisor.name ?? advisor.email ?? `User #${advisor.id}`;

  const [lead] = await db
    .update(leadsTable)
    .set({
      ownerUserId: advisor.id,
      assignedTo: advisorName,
      status:
        existing.status === "new" || existing.status === "assigned"
          ? "assigned"
          : existing.status,
      phase: existing.phase === "new" ? "contacted" : existing.phase,
      ...(existing.phase === "new" ? { stageEnteredAt: new Date() } : {}),
    })
    .where(
      and(
        eq(leadsTable.id, params.data.id),
        eq(leadsTable.dealerId, activeDealerId(res)),
      ),
    )
    .returning();

  // Manual override still advances the round-robin clock for fairness.
  await stampLeadAssignment(activeDealerId(res), advisor.id);

  await logLeadEvent(
    lead!,
    "advisor_assigned",
    `Assigned to ${advisorName}`,
    `${actorName(res)} assigned this lead to ${advisorName}.`,
    actorName(res),
  );

  // R6.2 #2 Assigned Lead → advisor (In-App + Email, key lead:assigned:{id}:{uid}).
  notifyLeadAssigned(lead!);

  if (lead!.email) {
    const vehicle = await vehicleLabel(lead!.dealerId, lead!.interestedVehicleId);
    await enqueueEmail({
      template: "lead_assignment",
      to: lead!.email,
      dealerId: lead!.dealerId,
      customerId: lead!.customerId,
      leadId: lead!.id,
      data: { advisor: advisorName, vehicle: vehicle ?? "" },
    });
  }

  res.json(GetLeadResponse.parse(lead));
});

// Gated stage advance: each target stage has a checklist that must be met
// before the lead moves forward. Unmet criteria come back as a 422 so the
// client can render a "Review & Advance" checklist.
// Stage-advance model + checks now live in ../lib/stage-review (shared with
// the pipeline-progression agent worker).

// Phase-wise review: evaluate every stage gate's checklist for this lead so
// the client can run a stepper review (pass / needs attention + owners).
router.get("/leads/:id/review", async (req, res): Promise<void> => {
  const params = GetLeadReviewParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const dealerId = activeDealerId(res);
  const [storedLead] = await db
    .select()
    .from(leadsTable)
    .where(and(eq(leadsTable.id, params.data.id), eq(leadsTable.dealerId, dealerId)));
  if (!storedLead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }
  const lead = (await withEffectiveContactDates(dealerId, [storedLead]))[0]!;

  const leadDeals = await db
    .select()
    .from(dealsTable)
    .where(and(eq(dealsTable.dealerId, dealerId), eq(dealsTable.leadId, lead.id)));
  const checks = buildStageChecks(lead, dealerId, leadDeals);

  const fromIdx = PHASE_ORDER.indexOf(lead.phase);
  const stageKeys = Object.keys(ADVANCE_TARGET_PHASE) as (keyof typeof ADVANCE_TARGET_PHASE)[];
  const stages = [];
  for (const stage of stageKeys) {
    const targetPhase = ADVANCE_TARGET_PHASE[stage];
    const toIdx = PHASE_ORDER.indexOf(targetPhase);
    const checklist = await getActiveChecklist(dealerId, stage as ChecklistStage);
    const items = [];
    for (const item of checklist.items) {
      if (!item.enabled) continue;
      const check = checks[item.key];
      items.push({
        key: item.key,
        label: item.label,
        met: check ? Boolean(await check()) : true,
        owner: CHECK_OWNER[item.key] ?? "Sales Advisor",
      });
    }
    stages.push({
      stage,
      label: REVIEW_STAGE_LABEL[stage] ?? stage,
      targetPhase,
      state:
        toIdx <= fromIdx
          ? ("passed" as const)
          : toIdx === fromIdx + 1
            ? ("current" as const)
            : ("upcoming" as const),
      items,
    });
  }

  // Delivery phase: not a lead-stage advance (deals own delivery), but the
  // review must surface delivery readiness — GRA duty filing included.
  const dealIds = leadDeals.map((d) => d.id);
  // GRA gates are created with refType "vehicle" (filings may be submitted
  // deal-less from the Documents tab), so match on both the linked deals'
  // vehicles and the lead's interested vehicle — not just deal refs.
  const graVehicleIds = [
    ...new Set(
      [
        ...leadDeals.map((d) => d.vehicleId),
        lead.interestedVehicleId,
      ].filter((v): v is number => v != null),
    ),
  ];
  const graRefConds: SQL[] = [];
  if (dealIds.length > 0)
    graRefConds.push(
      and(
        eq(gatesTable.refType, "deal"),
        inArray(gatesTable.refId, dealIds),
      )!,
    );
  if (graVehicleIds.length > 0)
    graRefConds.push(
      and(
        eq(gatesTable.refType, "vehicle"),
        inArray(gatesTable.refId, graVehicleIds),
      )!,
    );
  const graGates =
    graRefConds.length > 0
      ? await db
          .select({ status: gatesTable.status })
          .from(gatesTable)
          .where(
            and(
              eq(gatesTable.dealerId, dealerId),
              eq(gatesTable.type, "gra_filing"),
              or(...graRefConds),
            ),
          )
      : [];
  const graFiled = graGates.some(
    (g) => g.status === "approved" || g.status === "adjusted",
  );
  const primaryDeal = leadDeals[0];
  const paymentSettled = Boolean(
    primaryDeal &&
      (primaryDeal.stage === "committed" || primaryDeal.stage === "delivered"),
  );
  const delivered = Boolean(primaryDeal && primaryDeal.stage === "delivered");
  stages.push({
    stage: "delivery",
    label: "Delivery",
    targetPhase: "won",
    state: delivered
      ? ("passed" as const)
      : lead.phase === "won"
        ? ("current" as const)
        : ("upcoming" as const),
    items: [
      {
        key: "gra_duty_filed",
        label: "GRA duty filing approved (optional)",
        met: graFiled,
        owner: "GRA / Compliance",
        optional: true,
      },
      {
        key: "payment_settled",
        label: "Payment settled (deal committed)",
        met: paymentSettled,
        owner: "Finance",
      },
      {
        key: "vehicle_delivered",
        label: "Vehicle handed over to the customer",
        met: delivered,
        owner: "Sales Advisor",
      },
    ],
  });

  const next = stages.find(
    (s) => s.state === "current" && s.stage !== "delivery",
  );

  // 48h contact SLA (Layer 2): only while the lead is still being chased for
  // first contact. Breach lazily notifies the owner exactly once.
  let sla: { deadline: Date; remainingMs: number; breached: boolean } | null =
    null;
  if (
    (lead.phase === "new" || lead.phase === "contacted") &&
    !lead.contactedDate &&
    lead.status !== "lost" &&
    lead.status !== "converted"
  ) {
    const since = lead.stageEnteredAt ?? lead.createdAt;
    const deadline = new Date(since.getTime() + 48 * 60 * 60 * 1000);
    const remainingMs = deadline.getTime() - Date.now();
    sla = { deadline, remainingMs, breached: remainingMs <= 0 };
    if (sla.breached && !lead.slaBreachNotifiedAt && lead.ownerUserId) {
      // Compare-and-set: only the request that flips the marker notifies,
      // so concurrent review reads can never double-notify.
      const claimed = await db
        .update(leadsTable)
        .set({ slaBreachNotifiedAt: new Date() })
        .where(
          and(
            eq(leadsTable.id, lead.id),
            eq(leadsTable.dealerId, dealerId),
            isNull(leadsTable.slaBreachNotifiedAt),
          ),
        )
        .returning({ id: leadsTable.id });
      if (claimed.length === 1)
        await notifyUser({
        userId: lead.ownerUserId,
        dealerId,
        type: "assignment",
        title: `Contact SLA breached: ${lead.name}`,
        body: "The 48h first-contact window has passed with no logged call. Reach the customer now or close the lead with a reason.",
        link: `/lead/${lead.id}`,
      });
    }
  }

  res.json(
    GetLeadReviewResponse.parse({
      leadId: lead.id,
      phase: lead.phase,
      nextStage: next ? next.stage : null,
      sla,
      stages,
    }),
  );
});

router.post("/leads/:id/advance", async (req, res): Promise<void> => {
  const params = AdvanceLeadStageParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = AdvanceLeadStageBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const dealerId = activeDealerId(res);
  const [lead] = await db
    .select()
    .from(leadsTable)
    .where(and(eq(leadsTable.id, params.data.id), eq(leadsTable.dealerId, dealerId)));
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }

  const toStage = body.data.toStage as keyof typeof ADVANCE_TARGET_PHASE;
  const targetPhase = ADVANCE_TARGET_PHASE[toStage];
  const fromIdx = PHASE_ORDER.indexOf(lead.phase);
  const toIdx = PHASE_ORDER.indexOf(targetPhase);

  const unmet: string[] = [];
  if (toIdx !== fromIdx + 1) {
    unmet.push(
      toIdx <= fromIdx
        ? "Lead is already at or past this stage"
        : "Stages can't be skipped — advance one stage at a time",
    );
    res.status(422).json({ error: "Stage advance blocked", unmet });
    return;
  }

  const leadDeals = await db
    .select()
    .from(dealsTable)
    .where(and(eq(dealsTable.dealerId, dealerId), eq(dealsTable.leadId, lead.id)));

  // AUTO-DESK: when a lead advances into Negotiation (or an older affected
  // lead next attempts Sold) with interests but no deal, bind the current
  // frozen quote and copy every quote line into one aggregate draft deal.
  // Physical units remain unallocated until deal commitment.
  if (
    (toStage === "negotiation" || toStage === "sold") &&
    leadDeals.length === 0
  ) {
    const startedAt = Date.now();
    const autoDeal = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`lead-link:${dealerId}:${lead.id}`}))`,
      );
      const [existing] = await tx
        .select()
        .from(dealsTable)
        .where(and(
          eq(dealsTable.dealerId, dealerId),
          eq(dealsTable.leadId, lead.id),
        ))
        .limit(1);
      if (existing) return { deal: existing, created: false };

      const [quote] = await tx
        .select()
        .from(quotesTable)
        .where(and(
          eq(quotesTable.dealerId, dealerId),
          eq(quotesTable.leadId, lead.id),
          eq(quotesTable.status, "current"),
        ))
        .orderBy(desc(quotesTable.version))
        .limit(1)
        .for("update");
      if (!quote) return null;

      const [created] = await tx
        .insert(dealsTable)
        .values({
          dealerId,
          leadId: lead.id,
          quoteId: quote.id,
          customerId: lead.customerId ?? null,
          customerName: lead.name,
          vehicleId: quote.vehicleId!,
          vehiclePrice: quote.basePrice,
          otdPrice: quote.total,
          discount: quote.discountAmount,
          dutyFreeApproved: quote.dutyFreeStatus === "approved",
          taxSnapshot: quote.taxSnapshot,
          divisionId: lead.divisionId ?? (await defaultDivisionId(dealerId)),
          salesAdvisor: lead.assignedTo ?? null,
          salesAdvisorUserId: lead.ownerUserId ?? null,
          ...(lead.purchaseType
            ? {
                finalPaymentMethod:
                  lead.purchaseType === "finance" ? "bank_financing" : "cash",
              }
            : {}),
          depositPaid: lead.reservationFeePaid ?? false,
        })
        .returning();
      if (!created) return null;

      const items = await tx
        .select()
        .from(quoteItemsTable)
        .where(and(
          eq(quoteItemsTable.dealerId, dealerId),
          eq(quoteItemsTable.quoteId, quote.id),
        ))
        .orderBy(quoteItemsTable.position);
      const subtotal = items.reduce(
        (sum, item) => sum + item.basePrice * item.quantity,
        0,
      );
      if (items.length) {
        let assignedDiscount = 0;
        await tx.insert(dealItemsTable).values(items.map((item, index) => {
          const discount =
            index === items.length - 1
              ? Math.round((quote.discountAmount - assignedDiscount) * 100) / 100
              : subtotal > 0
                ? Math.round(
                    quote.discountAmount *
                      ((item.basePrice * item.quantity) / subtotal) *
                      100,
                  ) / 100
                : 0;
          assignedDiscount += discount;
          return {
            dealerId,
            dealId: created.id,
            quoteItemId: item.id,
            vehicleId: item.vehicleId,
            make: item.make,
            model: item.model,
            modelYear: item.modelYear,
            variant: item.trim,
            color: item.color,
            quantity: item.quantity,
            position: item.position,
            vehiclePrice: item.basePrice,
            discount,
            taxSnapshot: item.taxLines,
            total: item.total - discount,
          };
        }));
      }
      return { deal: created, created: true };
    });
    if (autoDeal) {
      if (!leadDeals.some((deal) => deal.id === autoDeal.deal.id)) {
        leadDeals.push(autoDeal.deal);
      }
      if (autoDeal.created) {
        await db.insert(timelineEventsTable).values({
          dealerId,
          customerId: lead.customerId,
          domain: "leads",
          kind: "deal_created",
          title: "Deal auto-desked by AURA",
          detail: `Aggregate draft deal #${autoDeal.deal.id} created from the current quote when the lead entered Negotiation — physical units will be allocated at commitment.`,
          actor: "AURA System",
          isAgent: false,
          refType: "lead",
          refId: lead.id,
        });
        await recordAgentRun({
          dealerId,
          agentKey: "auto_desk",
          runType: "auto_desk_deal",
          autonomy: "system",
          inputSource: "stage_advance",
          inputSummary: `Lead #${lead.id} advanced to Negotiation with no deal on file`,
          outputSummary: `Drafted aggregate deal #${autoDeal.deal.id} from the current quote`,
          confidence: 1,
          refType: "deal",
          refId: autoDeal.deal.id,
          latencyMs: Date.now() - startedAt,
          mutation: true,
          changeSummary: `No deal on file → aggregate draft deal #${autoDeal.deal.id} created from the frozen quote`,
          affectedEntities: [
            { type: "deal", id: autoDeal.deal.id },
            { type: "lead", id: lead.id },
          ],
        });
      }
    }
  }

  // Gate criteria come from the dealer's ACTIVE checklist config (versioned,
  // Settings → Stage Gates). Each item key maps to a built-in check; admins
  // can toggle items on/off and relabel them without a deploy.
  const checklist = await getActiveChecklist(dealerId, toStage as ChecklistStage);
  // selfHeal: the gated advance is a write path, so checks may auto-link the
  // account and backfill the primary contact instead of failing the gate.
  const checks = buildStageChecks(lead, dealerId, leadDeals, { selfHeal: true });
  for (const item of checklist.items) {
    if (!item.enabled) continue;
    const check = checks[item.key];
    if (!check) continue;
    if (!(await check())) unmet.push(item.label);
  }

  if (unmet.length > 0) {
    res.status(422).json({ error: "Stage advance blocked", unmet });
    return;
  }

  const [updated] = await db
    .update(leadsTable)
    .set({
      phase: targetPhase,
      stageEnteredAt: new Date(),
      ...(toStage === "sold" ? { status: "converted" } : {}),
    })
    .where(and(eq(leadsTable.id, lead.id), eq(leadsTable.dealerId, dealerId)))
    .returning();

  // Advancing past the contact chase ends the follow-up call cadence.
  await completeCadenceTasks(
    lead,
    "Lead advanced past the contact stage — cadence complete.",
  );

  // Sold locks the VIN: reserve the vehicle so it can't be sold twice.
  if (toStage === "sold" && lead.interestedVehicleId) {
    await db
      .update(vehiclesTable)
      .set({ status: "reserved" })
      .where(
        and(
          eq(vehiclesTable.id, lead.interestedVehicleId),
          eq(vehiclesTable.dealerId, dealerId),
          eq(vehiclesTable.status, "available"),
        ),
      );
  }

  await logLeadEvent(
    updated!,
    "stage_advanced",
    `Advanced to ${ADVANCE_STAGE_LABEL[toStage]}`,
    "All stage checklist criteria met.",
    actorName(res),
  );

  res.json(GetLeadResponse.parse(updated));
});

// Capacity-plan helpers now live in ../lib/capacity-blocks (shared with the
// public self-service booking page).

router.post("/leads/:id/test-drive", async (req, res): Promise<void> => {
  const params = ScheduleTestDriveParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = ScheduleTestDriveBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [existing] = await db
    .select()
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.id, params.data.id),
        eq(leadsTable.dealerId, activeDealerId(res)),
      ),
    );
  if (!existing) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }

  if (!parsed.data.waiverAccepted) {
    res.status(422).json({
      error: "The customer must sign the test-drive waiver before booking",
    });
    return;
  }

  const when = new Date(parsed.data.scheduledAt);
  const tz = await dealerTimezone(existing.dealerId);

  // All drives run on the shared 30-minute grid so overlap detection and the
  // customer self-service page stay in agreement.
  if (!slotGridAligned(when, tz)) {
    res.status(422).json({
      error: "Test drives start on the half hour (e.g. 9:00 or 9:30) — pick a slot on the 30-minute grid.",
    });
    return;
  }

  // A10 — the vehicle itself must still be available for a drive.
  const checkLead = {
    ...existing,
    interestedVehicleId: parsed.data.vehicleId ?? existing.interestedVehicleId,
  };
  const vehicleError = await vehicleAvailabilityError(checkLead);
  if (vehicleError) {
    res.status(409).json({ error: vehicleError });
    return;
  }
  // Manager capacity planning: the vehicle or the lead's advisor may be
  // blocked out for that day.
  const blockVehicleIds =
    checkLead.interestedVehicleId != null
      ? await modelUnitIds(existing.dealerId, checkLead.interestedVehicleId)
      : [];

  // Atomic slot claim: per-dealer advisory lock + in-transaction overlap and
  // capacity re-check, so a staff booking can't race a self-service one.
  let claimError: string | null = null;
  const lead = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(42001, ${existing.dealerId})`,
    );
    // One drive at a time: any other lead's drive within ±30 minutes blocks
    // the slot (legacy off-grid bookings overlap too).
    const lo = new Date(when.getTime() - SLOT_LENGTH_MS);
    const hi = new Date(when.getTime() + SLOT_LENGTH_MS);
    const [conflict] = await tx
      .select({ id: leadsTable.id, name: leadsTable.name })
      .from(leadsTable)
      .where(
        and(
          eq(leadsTable.dealerId, existing.dealerId),
          isNotNull(leadsTable.testDriveAt),
          gte(leadsTable.testDriveAt, new Date(lo.getTime() + 1)),
          lte(leadsTable.testDriveAt, new Date(hi.getTime() - 1)),
          ne(leadsTable.id, params.data.id),
        ),
      );
    if (conflict) {
      claimError = `That time slot is already booked (${conflict.name}) — pick another time`;
      return null;
    }
    const blockedDays = await capacityBlockedDays(existing.dealerId, {
      vehicleIds: blockVehicleIds,
      advisorUserId: existing.ownerUserId,
    });
    if (isSlotBlocked(blockedDays, when, tz)) {
      claimError =
        "That time is blocked in the capacity plan (vehicle or advisor unavailable) — pick another slot.";
      return null;
    }
    const [row] = await tx
      .update(leadsTable)
      .set({
        testDriveAt: when,
        testDriveBranch:
          parsed.data.branch ?? existing.preferredBranch ?? null,
        interestedVehicleId:
          parsed.data.vehicleId ?? existing.interestedVehicleId,
        testDriveLicence: parsed.data.licenceNumber,
        testDriveWaiver: true,
        status: "test_drive",
        phase:
          existing.phase === "new" || existing.phase === "contacted"
            ? "qualified"
            : existing.phase,
        ...(existing.phase === "new" || existing.phase === "contacted"
          ? { stageEnteredAt: new Date() }
          : {}),
      })
      .where(
        and(
          eq(leadsTable.id, params.data.id),
          eq(leadsTable.dealerId, activeDealerId(res)),
        ),
      )
      .returning();
    return row ?? null;
  });
  if (!lead) {
    res.status(409).json({
      error: claimError ?? "That time is unavailable — pick another slot.",
    });
    return;
  }

  // A booked test drive promotes the lead to an account.
  lead!.customerId = await ensureAccountForLead(lead!);

  // First-class record: supersede any prior scheduled drive, insert the new one.
  await db
    .update(testDrivesTable)
    .set({ status: "cancelled", cancelledAt: new Date() })
    .where(
      and(
        eq(testDrivesTable.dealerId, lead!.dealerId),
        eq(testDrivesTable.leadId, lead!.id),
        eq(testDrivesTable.status, "scheduled"),
      ),
    );
  await db.insert(testDrivesTable).values({
    dealerId: lead!.dealerId,
    leadId: lead!.id,
    vehicleId: lead!.interestedVehicleId ?? null,
    customerId: lead!.customerId ?? null,
    status: "scheduled",
    scheduledAt: when,
    branch: lead!.testDriveBranch,
    licenceNumber: lead!.testDriveLicence,
    waiverAccepted: true,
    bookedVia: "staff",
  });

  const vehicle = await vehicleLabel(lead!.dealerId, lead!.interestedVehicleId);
  const dateStr = formatDealerSlot(when, tz).split(" at ")[0]!;
  const timeStr = formatDealerTime(when, tz);

  await logLeadEvent(
    lead!,
    "test_drive_scheduled",
    `Test drive booked for ${dateStr}`,
    `${vehicle ?? "Vehicle"} at ${timeStr}${lead!.testDriveBranch ? ` — ${lead!.testDriveBranch} branch` : ""}.`,
    actorName(res),
  );

  // Calendar invite lands on both the customer's and the owner's calendar.
  const owner = await ownerCalendarContact(lead!.ownerUserId);
  const calendarFields = testDriveCalendarFields(lead!, vehicle, owner);

  if (lead!.email) {
    await enqueueEmail({
      template: "test_drive_confirmation",
      to: lead!.email,
      dealerId: lead!.dealerId,
      customerId: lead!.customerId,
      leadId: lead!.id,
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
      template: "test_drive_owner_invite",
      to: owner.email,
      dealerId: lead!.dealerId,
      customerId: lead!.customerId,
      data: {
        leadName: lead!.name,
        vehicle: vehicle ?? "",
        date: dateStr,
        time: timeStr,
        branch: lead!.testDriveBranch ?? "Main Showroom",
        ...calendarFields,
      },
    });
  }

  if (lead!.ownerUserId) {
    await notifyUser({
      userId: lead!.ownerUserId,
      dealerId: lead!.dealerId,
      type: "task",
      title: `Test drive: ${lead!.name} — ${dateStr}`,
      body: `${vehicle ?? "Vehicle"} at ${timeStr}. Have it detailed and ready.`,
      link: "/pipeline",
    });
  }

  // A10 — soft-lock single-unit models + queue the 24h WhatsApp reminder.
  await afterTestDriveBooked(lead!, when, vehicle);

  res.json(GetLeadResponse.parse(lead));
});

// A10 — deterministic slot-candidate check: the offerable showroom grid with
// per-slot vehicle-side (showroom + unit) and customer-side availability.
router.get(
  "/leads/:id/availability-check",
  async (req, res): Promise<void> => {
    const params = GetLeadTestDriveAvailabilityParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const dealerId = activeDealerId(res);
    const [lead] = await db
      .select()
      .from(leadsTable)
      .where(
        and(eq(leadsTable.id, params.data.id), eq(leadsTable.dealerId, dealerId)),
      );
    if (!lead) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    if (!lead.interestedVehicleId) {
      res
        .status(409)
        .json({ error: "This lead has no interested vehicle to check" });
      return;
    }
    const [vehicle] = await db
      .select()
      .from(vehiclesTable)
      .where(
        and(
          eq(vehiclesTable.id, lead.interestedVehicleId),
          eq(vehiclesTable.dealerId, dealerId),
        ),
      );
    if (!vehicle) {
      res.status(409).json({ error: "Interested vehicle no longer exists" });
      return;
    }

    // Units of this model still on the floor (drives the soft-lock decision).
    const units = await db
      .select({ id: vehiclesTable.id })
      .from(vehiclesTable)
      .where(
        and(
          eq(vehiclesTable.dealerId, dealerId),
          eq(vehiclesTable.make, vehicle.make),
          eq(vehiclesTable.model, vehicle.model),
          eq(vehiclesTable.status, "available"),
        ),
      );

    // The showroom runs one drive at a time — any other lead's booking blocks
    // the slot on the vehicle side.
    const tz = await dealerTimezone(dealerId);
    const slots = offeredSlotTimes(tz);
    const windowStart = slots[0]!;
    const windowEnd = new Date(
      slots[slots.length - 1]!.getTime() + SLOT_LENGTH_MS,
    );
    const otherBookings = await db
      .select({ at: leadsTable.testDriveAt })
      .from(leadsTable)
      .where(
        and(
          eq(leadsTable.dealerId, dealerId),
          isNotNull(leadsTable.testDriveAt),
          ne(leadsTable.id, lead.id),
          gte(leadsTable.testDriveAt, windowStart),
          lte(leadsTable.testDriveAt, windowEnd),
        ),
      );
    const taken = new Set(otherBookings.map((r) => r.at!.getTime()));
    // Manager capacity planning: days where the vehicle or the lead's
    // advisor is blocked out are not offerable.
    // Blocks may sit on ANY unit of the model (the planner shows one
    // representative demo unit regardless of its sale status).
    const modelUnits = await db
      .select({ id: vehiclesTable.id })
      .from(vehiclesTable)
      .where(
        and(
          eq(vehiclesTable.dealerId, dealerId),
          eq(vehiclesTable.make, vehicle.make),
          eq(vehiclesTable.model, vehicle.model),
        ),
      );
    const blockedDays = await capacityBlockedDays(dealerId, {
      vehicleIds: [vehicle.id, ...modelUnits.map((u) => u.id)],
      advisorUserId: lead.ownerUserId,
    });
    const drivable = !(await vehicleAvailabilityError(lead));
    const ownBooking = lead.testDriveAt?.getTime() ?? null;

    res.json(
      GetLeadTestDriveAvailabilityResponse.parse({
        vehicleId: vehicle.id,
        unitCount: units.length,
        slots: slots.map((start) => ({
          start: start.toISOString(),
          end: new Date(start.getTime() + SLOT_LENGTH_MS).toISOString(),
          vehicleFree:
            drivable &&
            !taken.has(start.getTime()) &&
            !isSlotBlocked(blockedDays, start, tz),
          customerFree: ownBooking !== start.getTime(),
        })),
      }),
    );
  },
);

router.post(
  "/leads/:id/availability-check",
  async (req, res): Promise<void> => {
    const params = CheckLeadAvailabilityParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const [existing] = await db
      .select()
      .from(leadsTable)
      .where(
        and(
          eq(leadsTable.id, params.data.id),
          eq(leadsTable.dealerId, activeDealerId(res)),
        ),
      );
    if (!existing) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    if (!existing.interestedVehicleId) {
      res
        .status(409)
        .json({ error: "This lead has no interested vehicle to check" });
      return;
    }

    const [vehicle] = await db
      .select()
      .from(vehiclesTable)
      .where(
        and(
          eq(vehiclesTable.id, existing.interestedVehicleId),
          eq(vehiclesTable.dealerId, activeDealerId(res)),
        ),
      );
    if (!vehicle) {
      res.status(409).json({ error: "Interested vehicle no longer exists" });
      return;
    }

    const isAvailable = vehicle.status === "available";
    const [lead] = await db
      .update(leadsTable)
      .set({
        availability: isAvailable ? "available" : "back_order",
        status: isAvailable ? "decision" : "back_order",
      })
      .where(
        and(
          eq(leadsTable.id, params.data.id),
          eq(leadsTable.dealerId, activeDealerId(res)),
        ),
      )
      .returning();

    const label = `${vehicle.year} ${vehicle.make} ${vehicle.model}`;
    await logLeadEvent(
      lead!,
      isAvailable ? "vehicle_available" : "back_order_created",
      isAvailable
        ? `${label} is available`
        : `${label} unavailable — back order raised`,
      isAvailable
        ? "Inventory confirmed the vehicle is in stock. Proceed to the payment decision."
        : `Vehicle is currently ${vehicle.status.replace("_", " ")}. The lead is held on back order until stock lands.`,
      "Inventory Check",
      true,
    );

    // Back-order landing: if the reservation fee was already collected while
    // the unit was out of stock, block it the moment it becomes available —
    // conditional update = race-safe against a concurrent sale.
    if (isAvailable && existing.reservationFeePaid) {
      const [reserved] = await db
        .update(vehiclesTable)
        .set({ status: "reserved" })
        .where(
          and(
            eq(vehiclesTable.id, vehicle.id),
            eq(vehiclesTable.dealerId, activeDealerId(res)),
            eq(vehiclesTable.status, "available"),
          ),
        )
        .returning({ id: vehiclesTable.id });
      if (reserved) {
        await logLeadEvent(
          lead!,
          "vehicle_reserved",
          "Unit blocked in inventory",
          `Reservation fee was already collected — ${label} is now reserved for this lead.`,
          "Inventory Check",
          true,
        );
      }
    }

    if (!isAvailable && lead!.ownerUserId) {
      await notifyUser({
        userId: lead!.ownerUserId,
        dealerId: lead!.dealerId,
        type: "system",
        title: `Back order: ${lead!.name}`,
        body: `${label} is ${vehicle.status.replace("_", " ")}. Keep the client warm until stock arrives.`,
        link: "/pipeline",
      });
    }

    res.json(GetLeadResponse.parse(lead));
  },
);

router.post("/leads/:id/decision", async (req, res): Promise<void> => {
  const params = RecordLeadDecisionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = RecordLeadDecisionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [existing] = await db
    .select()
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.id, params.data.id),
        eq(leadsTable.dealerId, activeDealerId(res)),
      ),
    );
  if (!existing) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }

  const choice = parsed.data.choice;

  // "Not interested" closes the lead: release any test-drive soft-lock on the
  // interested vehicle and cancel every still-queued outbound draft so no
  // follow-up lands after the customer said no.
  if (choice === "not_interested") {
    const reason = parsed.data.reason?.trim() || "Customer not interested";
    const [lost] = await db
      .update(leadsTable)
      .set({
        status: "lost",
        phase: "lost",
        closureReason: reason,
        stageEnteredAt: new Date(),
      })
      .where(
        and(
          eq(leadsTable.id, params.data.id),
          eq(leadsTable.dealerId, activeDealerId(res)),
        ),
      )
      .returning();

    if (lost!.interestedVehicleId) {
      await db
        .update(vehiclesTable)
        .set({ holdUntil: null, holdReason: null })
        .where(
          and(
            eq(vehiclesTable.id, lost!.interestedVehicleId),
            eq(vehiclesTable.dealerId, lost!.dealerId),
            ilike(vehiclesTable.holdReason, `%${lost!.name}%`),
          ),
        );
    }

    await db
      .update(emailLogsTable)
      .set({ status: "cancelled" })
      .where(
        and(
          eq(emailLogsTable.dealerId, lost!.dealerId),
          eq(emailLogsTable.leadId, lost!.id),
          eq(emailLogsTable.status, "queued"),
        ),
      );

    await logLeadEvent(
      lost!,
      "lead_lost",
      "Client decided not to proceed",
      `${reason}. Queued outreach cancelled and any test-drive hold released.`,
      actorName(res),
    );

    res.json(GetLeadResponse.parse(lost));
    return;
  }

  const [lead] = await db
    .update(leadsTable)
    .set({
      purchaseType: choice,
      status: "converted",
      phase: "negotiation",
      stageEnteredAt: new Date(),
    })
    .where(
      and(
        eq(leadsTable.id, params.data.id),
        eq(leadsTable.dealerId, activeDealerId(res)),
      ),
    )
    .returning();

  await logLeadEvent(
    lead!,
    "purchase_decision",
    choice === "cash"
      ? "Client chose to pay cash"
      : "Client chose financing",
    choice === "cash"
      ? "Routing to vehicle booking with a cash structure."
      : "Handing off to the finance workflow for an application.",
    actorName(res),
  );

  res.json(GetLeadResponse.parse(lead));
});

// Link a lead to a customer account (manual counterpart of the automatic
// promotion). Backfills the account's primary contact from the lead so the
// Pre-Book "Account linked with a primary contact" check passes.
router.post("/leads/:id/link-account", async (req, res): Promise<void> => {
  const params = LinkLeadAccountParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = LinkLeadAccountBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const dealerId = activeDealerId(res);

  const [lead] = await db
    .select()
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.id, params.data.id),
        eq(leadsTable.dealerId, dealerId),
        isNull(leadsTable.deletedAt),
      ),
    );
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }
  if (lead.customerId && lead.customerId !== parsed.data.customerId) {
    res.status(409).json({
      error: `This lead is already linked to account #${lead.customerId} — unlinking is not supported, merge the accounts instead`,
    });
    return;
  }

  const [customer] = await db
    .select()
    .from(customersTable)
    .where(
      and(
        eq(customersTable.id, parsed.data.customerId),
        eq(customersTable.dealerId, dealerId),
        isNull(customersTable.deletedAt),
      ),
    );
  if (!customer) {
    res.status(404).json({ error: "Customer account not found" });
    return;
  }

  const [updated] = await db
    .update(leadsTable)
    .set({ customerId: customer.id })
    .where(and(eq(leadsTable.id, lead.id), eq(leadsTable.dealerId, dealerId)))
    .returning();

  await ensurePrimaryContact(dealerId, customer.id, {
    name: lead.name,
    email: lead.email,
    phone: lead.phone,
    title: lead.title ?? null,
  });

  if (!lead.customerId) {
    await logLeadEvent(
      updated!,
      "account_linked",
      `Linked to account "${customer.name}"`,
      `${actorName(res)} linked this lead to customer account #${customer.id}.`,
      actorName(res),
    );
  }

  res.json(GetLeadResponse.parse(updated));
});

router.patch("/leads/:id", async (req, res): Promise<void> => {
  const params = UpdateLeadParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  if (Array.isArray(req.body?.vehicleInterests) && req.body.vehicleInterests.some(
    (interest: unknown) => typeof interest === "object" && interest !== null &&
      (interest as { vehicleId?: unknown }).vehicleId != null,
  )) {
    res.status(422).json({ error: "vehicleInterests must not contain vehicleId; physical units are assigned only at deal allocation." });
    return;
  }
  const parsed = UpdateLeadBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { vehicleInterests, ...leadPatch } = parsed.data;
  if (parsed.data.interestedVehicleId != null) {
    res.status(422).json({ error: "Physical vehicle selection is read-only history; update vehicleInterests specifications instead." });
    return;
  }
  const normalizedInterests = vehicleInterests
    ? [...vehicleInterests].sort((a, b) => a.position - b.position)
    : null;
  if (
    vehicleInterests &&
    new Set(vehicleInterests.map((interest) =>
      [interest.make, interest.model, interest.modelYear, interest.variant ?? "", interest.color ?? ""]
        .join("|").toLocaleLowerCase(),
    )).size !==
      vehicleInterests.length
  ) {
    res.status(422).json({
      error: "duplicate_vehicle_interests",
      detail: "Each vehicle specification may appear only once in vehicleInterests",
    });
    return;
  }
  // Canonical interests are demand specifications, never physical units.
  const primaryInterestId = normalizedInterests ? null : undefined;

  // Field-level permissions: reject edits to restricted field groups.
  const blocked = await findBlockedEditField(res.locals.user, "leads", parsed.data);
  if (blocked) {
    res.status(403).json({
      error: `Your role cannot edit ${blocked.groupLabel} (field: ${blocked.field})`,
    });
    return;
  }

  const [before] = await db
    .select()
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.id, params.data.id),
        eq(leadsTable.dealerId, activeDealerId(res)),
        isNull(leadsTable.deletedAt),
      ),
    );
  if (!before) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }

  // Closing a lead requires a reason (Layer 2): status → lost must carry a
  // closure reason in the same request or already on the record.
  const goingLost =
    (parsed.data.status === "lost" && before.status !== "lost") ||
    (parsed.data.phase === "lost" && before.phase !== "lost");
  if (goingLost && !parsed.data.closureReason?.trim() && !before.closureReason) {
    res.status(422).json({
      error: "Closing a lead requires a reason",
      unmet: ["closure_reason_required"],
    });
    return;
  }

  // Reopening a lost lead: leaving lost (by phase and/or status) clears the
  // closure reason so the record no longer looks closed, and is audited as a
  // reopen below. Resulting state is computed field-by-field so status-only
  // or phase-only patches are both handled.
  const resultPhase = parsed.data.phase ?? before.phase;
  const resultStatus = parsed.data.status ?? before.status;
  const wasLost = before.phase === "lost" || before.status === "lost";
  const resultingLost = resultPhase === "lost" || resultStatus === "lost";
  const reopening = wasLost && !resultingLost;

  // While a lead remains lost its closure reason cannot be blanked out —
  // every closed lead must carry a reason.
  if (
    resultingLost &&
    "closureReason" in (req.body ?? {}) &&
    !parsed.data.closureReason?.trim()
  ) {
    res.status(422).json({
      error: "A lost lead must keep a closure reason",
      unmet: ["closure_reason_required"],
    });
    return;
  }

  // Vehicle swap + lead update run as ONE transaction with the lead row
  // locked, so concurrent swaps serialize instead of orphaning reservations:
  // reserve the replacement (when the fee is/becomes paid) BEFORE the lead
  // points at it, update the lead, then atomically release the old unit —
  // all of it rolls back together if any step loses a race.
  const dealerId = activeDealerId(res);
  let lead: typeof before | undefined;
  let swappedFromVehicleId: number | null = null;
  let newVehicleReserved = false;
  let releasedOldVehicle = false;
  let swapInVehicle: { id: number; vin: string | null; year: number | null; make: string; model: string } | null = null;
  let swapFailure: { status: number; body: Record<string, unknown> } | null =
    null;
  const SWAP_ABORT = new Error("lead-vehicle-swap-abort");
  try {
    await db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(leadsTable)
        .where(
          and(
            eq(leadsTable.id, params.data.id),
            eq(leadsTable.dealerId, dealerId),
            isNull(leadsTable.deletedAt),
          ),
        )
        .for("update");
      if (!locked) {
        swapFailure = { status: 404, body: { error: "Lead not found" } };
        throw SWAP_ABORT;
      }
      const requestedPrimaryId =
        normalizedInterests ? undefined : parsed.data.interestedVehicleId;
      const swapping =
        requestedPrimaryId !== undefined &&
        requestedPrimaryId !== locked.interestedVehicleId;
      const feePaidAfter =
        parsed.data.reservationFeePaid ?? locked.reservationFeePaid;
      if (swapping && requestedPrimaryId != null) {
        const [newVehicle] = await tx
          .select({
            id: vehiclesTable.id,
            status: vehiclesTable.status,
            vin: vehiclesTable.vin,
            year: vehiclesTable.year,
            make: vehiclesTable.make,
            model: vehiclesTable.model,
          })
          .from(vehiclesTable)
          .where(
            and(
                eq(vehiclesTable.id, requestedPrimaryId),
              eq(vehiclesTable.dealerId, dealerId),
              isNull(vehiclesTable.deletedAt),
            ),
          );
        if (!newVehicle) {
          swapFailure = { status: 404, body: { error: "Vehicle not found" } };
          throw SWAP_ABORT;
        }
        swapInVehicle = newVehicle;
        if (feePaidAfter) {
          // Fee collected (already or in this request) — the replacement must
          // be blocked in inventory. Conditional update = race-safe.
          const [reserved] = await tx
            .update(vehiclesTable)
            .set({ status: "reserved" })
            .where(
              and(
                eq(vehiclesTable.id, newVehicle.id),
                eq(vehiclesTable.dealerId, dealerId),
                eq(vehiclesTable.status, "available"),
              ),
            )
            .returning({ id: vehiclesTable.id });
          if (!reserved) {
            swapFailure = {
              status: 422,
              body: {
                error: "Selected vehicle is no longer available",
                unmet: ["vehicle_not_available"],
              },
            };
            throw SWAP_ABORT;
          }
          newVehicleReserved = true;
        } else if (newVehicle.status !== "available") {
          swapFailure = {
            status: 422,
            body: {
              error: "Selected vehicle is not available",
              unmet: ["vehicle_not_available"],
            },
          };
          throw SWAP_ABORT;
        }
      }
      if (normalizedInterests) {
        await tx.delete(leadVehicleInterestsTable).where(and(
          eq(leadVehicleInterestsTable.dealerId, dealerId),
          eq(leadVehicleInterestsTable.leadId, locked.id),
        ));
        if (normalizedInterests.length) await tx.insert(leadVehicleInterestsTable).values(
          normalizedInterests.map((interest, position) => ({
            dealerId, leadId: locked.id, vehicleId: null,
            make: interest.make, model: interest.model, modelYear: interest.modelYear,
            variant: interest.variant, color: interest.color, unitPrice: interest.unitPrice,
            quantity: interest.quantity, position,
          })),
        );
        // A changed demand specification invalidates every commercial
        // authority tied to the former snapshot in this same transaction.
        // Deal creation only binds `current`, so stale quotes/discounts/duty
        // approvals cannot be selected in the interval after the lead update.
        await tx.update(quotesTable).set({ status: "superseded" }).where(and(
          eq(quotesTable.dealerId, dealerId),
          eq(quotesTable.leadId, locked.id),
          eq(quotesTable.status, "current"),
        ));
      }

      const [updated] = await tx
        .update(leadsTable)
        .set({
          ...leadPatch,
           ...(normalizedInterests ? { interestedVehicleId: null } : {}),
          ...(parsed.data.phase && parsed.data.phase !== locked.phase
            ? { stageEnteredAt: new Date() }
            : {}),
          ...(reopening ? { closureReason: null } : {}),
        })
        .where(
          and(
            eq(leadsTable.id, params.data.id),
            eq(leadsTable.dealerId, dealerId),
          ),
        )
        .returning();
      if (!updated) {
        swapFailure = { status: 404, body: { error: "Lead not found" } };
        throw SWAP_ABORT;
      }
      lead = updated;

      // Free the previous unit back to available — a single conditional
      // update whose NOT EXISTS predicates keep it atomic with the claim
      // checks (no check-then-update window).
      if (swapping && locked.interestedVehicleId != null) {
        swappedFromVehicleId = locked.interestedVehicleId;
        const oldVehicleId = locked.interestedVehicleId;
        const [released] = await tx
          .update(vehiclesTable)
          .set({ status: "available" })
          .where(
            and(
              eq(vehiclesTable.dealerId, dealerId),
              eq(vehiclesTable.id, oldVehicleId),
              eq(vehiclesTable.status, "reserved"),
              notExists(
                db
                  .select({ id: dealsTable.id })
                  .from(dealsTable)
                  .where(
                    and(
                      eq(dealsTable.dealerId, dealerId),
                      eq(dealsTable.vehicleId, oldVehicleId),
                      notInArray(dealsTable.stage, [
                        "cancelled",
                        "lost",
                        "delivered",
                      ]),
                    ),
                  ),
              ),
              notExists(
                db
                  .select({ id: bookingsTable.id })
                  .from(bookingsTable)
                  .where(
                    and(
                      eq(bookingsTable.dealerId, dealerId),
                      eq(bookingsTable.vehicleId, oldVehicleId),
                      eq(bookingsTable.status, "active"),
                    ),
                  ),
              ),
              // A paid reservation's active soft-lock also keeps the unit.
              notExists(
                db
                  .select({ id: reservationAllocationsTable.id })
                  .from(reservationAllocationsTable)
                  .where(
                    and(
                      eq(reservationAllocationsTable.dealerId, dealerId),
                      eq(reservationAllocationsTable.vehicleId, oldVehicleId),
                      eq(reservationAllocationsTable.status, "active"),
                    ),
                  ),
              ),
            ),
          )
          .returning({ id: vehiclesTable.id });
        releasedOldVehicle = !!released;
      }
    });
  } catch (err) {
    // (cast: TS can't see assignments made inside the transaction closure)
    const failure = swapFailure as {
      status: number;
      body: Record<string, unknown>;
    } | null;
    if (failure) {
      res.status(failure.status).json(failure.body);
      return;
    }
    throw err;
  }

  if (goingLost) {
    // Closing the lead ends the follow-up cadence.
    await completeCadenceTasks(lead!, "Lead closed — cadence stopped.");
  }
  if (reopening) {
    // A reopened lead must not sit dormant: give the owner a fresh follow-up
    // task (independent of the historical miss count, which stays archived).
    const due = new Date(Date.now() + 86_400_000);
    await db.insert(tasksTable).values({
      dealerId: lead!.dealerId,
      leadId: lead!.id,
      kind: "cadence",
      title: `Follow-up call — reopened lead: ${lead!.name}`,
      description: `This lead was reopened from Lost into ${resultPhase}. Reach out to restart the conversation.`,
      assigneeUserId: lead!.ownerUserId ?? null,
      dueDate: zonedDayKey(due, await dealerTimezone(lead!.dealerId)),
      dueAt: due,
      priority: "high",
    });
  }
  if (parsed.data.status && parsed.data.status !== before.status) {
    await logLeadEvent(
      lead!,
      "status_updated",
      `Status moved to ${parsed.data.status.replace("_", " ")}`,
      `${actorName(res)} updated the lead status from ${before.status.replace("_", " ")}.`,
      actorName(res),
    );
  }
  if (parsed.data.phase && parsed.data.phase !== before.phase) {
    await logLeadEvent(
      lead!,
      reopening ? "lead_reopened" : "phase_updated",
      reopening ? "Lead reopened" : `Stage advanced`,
      reopening
        ? `${actorName(res)} reopened this lost lead and moved it to ${parsed.data.phase}.`
        : `${actorName(res)} moved the lead from ${before.phase} to ${parsed.data.phase}.`,
      actorName(res),
    );
  }

  if (before && lead) onLeadUpdated(before, lead);
  // Quote agent (A3): regenerate the Code when a pricing-relevant field
  // (vehicle, color, variant, financing) changed and a Code already exists.
  if (before && lead) {
    // A normalized-interest replacement is one commercial edit regardless of
    // whether its position-zero compatibility projection also changed.
    autoQuoteOnLeadUpdated(
      normalizedInterests && before.interestedVehicleId === lead.interestedVehicleId
        ? { ...before, interestedVehicleId: -1 }
        : before,
      lead,
    );
  }

  res.json(UpdateLeadResponse.parse((await withLeadVehicleInterests([lead!]))[0]));
});

router.delete("/leads/:id", async (req, res): Promise<void> => {
  const params = DeleteLeadParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const archive = z.object({ reason: z.string().trim().min(3).max(1000) }).safeParse(req.body);
  if (!archive.success) {
    res.status(422).json({ error: "A reason is required to request lead archive." });
    return;
  }
  const dealerId = activeDealerId(res);
  const [current] = await db.select().from(leadsTable).where(and(
    eq(leadsTable.id, params.data.id), eq(leadsTable.dealerId, dealerId), isNull(leadsTable.deletedAt),
  ));
  if (!current) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }
  const actorNameValue = actorName(res);
  const gate = await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(gatesTable).where(and(
      eq(gatesTable.dealerId, dealerId), eq(gatesTable.type, "lead_delete"),
      eq(gatesTable.refType, "lead"), eq(gatesTable.refId, current.id), eq(gatesTable.status, "pending"),
    ));
    if (existing) return existing;
    const [created] = await tx.insert(gatesTable).values({
      dealerId, type: "lead_delete", status: "pending", priority: "high",
      customerId: current.customerId ?? null, customerName: current.name,
      refType: "lead", refId: current.id, title: `Lead archive approval — ${current.name}`,
      summary: `${actorNameValue} requested archival. Reason: ${archive.data.reason}`,
      recommendation: "Approve only after confirming that this lead should be archived and its open work can be closed.",
      evidence: [{ label: "Reason", value: archive.data.reason }, { label: "Requested by", value: actorNameValue }],
    }).returning();
    return created!;
  });
  res.status(202).json({ pending: true, gateId: gate.id, message: "Lead archive requested for manager approval." });
});

// Restore lead visibility only. Archive-time operational closures are retained
// as history; silently resurrecting deals, bookings, deliveries, or stale gates
// would create conflicting holds and approvals.
router.post("/leads/:id/restore", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const user = res.locals.user;
  if (!user || !hasPermission(user, "leads", "delete")) {
    res.status(403).json({ error: "Missing permission: delete on leads" });
    return;
  }
  const [lead] = await db
    .update(leadsTable)
    .set({ deletedAt: null, deletedBy: null })
    .where(
      and(
        eq(leadsTable.id, id),
        eq(leadsTable.dealerId, activeDealerId(res)),
        isNotNull(leadsTable.deletedAt),
      ),
    )
    .returning();
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }
  res.json(UpdateLeadResponse.parse(lead));
});

// ---------------------------------------------------------------------------
// AI agent brief — per-lead next best actions + draft follow-up.
// Actions + risk are DETERMINISTIC (computed in lib/lead-brief.ts from the
// same per-dealer stage checklist that gates POST /leads/{id}/advance); the
// LLM only phrases the headline + customer draft, with deterministic
// fallbacks so the brief can never contradict the pipeline's real gates.
// ---------------------------------------------------------------------------
router.get("/leads/:id/agent-brief", async (req, res): Promise<void> => {
  const params = GetLeadAgentBriefParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const dealerId = activeDealerId(res);
  const [lead] = await db
    .select()
    .from(leadsTable)
    .where(
      and(eq(leadsTable.id, params.data.id), eq(leadsTable.dealerId, dealerId)),
    );
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }

  const [vehicle, deals, timeline] = await Promise.all([
    lead.interestedVehicleId
      ? db
          .select()
          .from(vehiclesTable)
          .where(
            and(
              eq(vehiclesTable.id, lead.interestedVehicleId),
              eq(vehiclesTable.dealerId, dealerId),
            ),
          )
          .then((r) => r[0])
      : Promise.resolve(undefined),
    db
      .select()
      .from(dealsTable)
      .where(and(eq(dealsTable.dealerId, dealerId), eq(dealsTable.leadId, lead.id))),
    db
      .select()
      .from(timelineEventsTable)
      .where(
        and(
          eq(timelineEventsTable.dealerId, dealerId),
          eq(timelineEventsTable.refType, "lead"),
          eq(timelineEventsTable.refId, lead.id),
          isNotNull(timelineEventsTable.refId),
        ),
      )
      .orderBy(desc(timelineEventsTable.createdAt))
      .limit(8),
  ]);

  const agentEnabled = await isAgentEnabled(dealerId, "pipeline_suggestions");

  // 1) Deterministic core: actions + risk from the REAL advance checklist.
  //    This part always runs — even with the agent paused, the advisor gets
  //    the checklist-driven playbook (just no AI phrasing or draft).
  const lastActivityAt = timeline[0]?.createdAt ?? null;
  const brief = await computeLeadBrief(
    lead,
    dealerId,
    deals,
    vehicle,
    lastActivityAt,
    agentEnabled,
  );
  const { stageGoal } = brief;

  // Grounding confidence: how much verified context the agent actually has.
  // Thin context (no contact channel, no vehicle, no activity) routes the
  // customer-facing draft to a human instead of auto-writing one.
  let confidence = 1;
  if (!lead.phone && !lead.email) confidence -= 0.3;
  if (!vehicle && !lead.selectedModel) confidence -= 0.2;
  if (timeline.length === 0) confidence -= 0.2;
  if (!lead.assignedTo) confidence -= 0.1;
  confidence = Math.round(Math.max(0, confidence) * 100) / 100;
  const routedToHuman = confidence < MIN_AGENT_CONFIDENCE;

  if (!agentEnabled) {
    await recordAgentRun({
      dealerId,
      agentKey: "pipeline_suggestions",
      runType: "lead_agent_brief",
      inputSource: "leads",
      refType: "lead",
      refId: lead.id,
      status: "blocked",
      errorMessage: "Agent paused by dealer kill switch",
    });
    res.json(
      GetLeadAgentBriefResponse.parse({
        headline: brief.fallbackHeadline,
        riskLevel: brief.riskLevel,
        stageGoal,
        actions: brief.actions,
        draftMessage: "",
        confidence,
        routedToHuman: true,
        agentDisabled: true,
      }),
    );
    return;
  }

  // 2) LLM is phrasing-only: headline + customer draft. Any failure or drift
  //    falls back to the deterministic templates — never a 502, never an
  //    action or risk level the pipeline doesn't agree with.
  const facts = [
    `Name: ${lead.name}; phase: ${lead.phase}; status: ${lead.status}; channel: ${lead.channel}.`,
    `Assigned to: ${lead.assignedTo ?? "UNASSIGNED"}.`,
    `First contact logged: ${lead.contactedDate ? "yes" : "NO"}; test drive: ${lead.testDriveAt ? `booked ${lead.testDriveAt.toISOString().slice(0, 10)}` : "not booked"}.`,
    vehicle
      ? `Interested vehicle: ${vehicle.year} ${vehicle.make} ${vehicle.model}.`
      : lead.selectedModel
        ? `Interested model: ${lead.selectedModel}.`
        : `No vehicle of interest recorded.`,
    `Risk level (computed, do NOT change): ${brief.riskLevel}. Reasons: ${brief.riskReasons.join(" ")}`,
    `Confirmed next actions (computed, do NOT invent others): ${brief.actions.map((a) => a.title).join("; ")}.`,
    lead.notes ? `Notes: ${guardUntrusted("lead_notes", lead.notes, 300)}` : "",
    timeline.length
      ? `Recent activity: ${timeline.map((t) => t.title).join("; ")}.`
      : "No recorded activity yet.",
  ]
    .filter(Boolean)
    .join("\n");

  const prompt = [
    `You are AURA, the agentic sales intelligence of an ultra-premium automotive dealership.`,
    `The current stage goal is to ${stageGoal}. The next actions and risk level are ALREADY decided by the pipeline engine below — you only write the words.`,
    facts,
    ``,
    `Return ONLY a JSON object (no markdown) with exactly these keys:`,
    `{`,
    `  "headline": string,     // one confident sentence on where this lead stands, consistent with the computed risk and actions`,
    `  "draftMessage": string  // a short, warm, ready-to-send follow-up message to the customer (no placeholders except their first name; do not mention internal process, risk, or checklists)`,
    `}`,
    `Luxury-brand tone: warm, confident, concise.`,
  ].join("\n");

  const briefStartedAt = Date.now();
  let headline = brief.fallbackHeadline;
  // Below the confidence floor the agent never writes a customer-facing
  // draft — the advisor composes it manually (routedToHuman).
  let draftMessage = routedToHuman ? "" : brief.fallbackDraft;
  let llmStatus: "ok" | "fallback" = "fallback";
  if (!routedToHuman) try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 700,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    });
    const textBlock = message.content.find((b) => b.type === "text");
    const raw = textBlock && textBlock.type === "text" ? textBlock.text : "";
    const jsonStart = raw.indexOf("{");
    const jsonEnd = raw.lastIndexOf("}");
    if (jsonStart !== -1 && jsonEnd !== -1) {
      const candidate = JSON.parse(raw.slice(jsonStart, jsonEnd + 1)) as Record<
        string,
        unknown
      >;
      if (
        typeof candidate.headline === "string" &&
        candidate.headline.trim().length > 0
      ) {
        headline = candidate.headline.trim();
        llmStatus = "ok";
      }
      if (
        typeof candidate.draftMessage === "string" &&
        candidate.draftMessage.trim().length > 0
      ) {
        draftMessage = candidate.draftMessage.trim();
      }
    }
  } catch (err) {
    req.log.warn(
      { err },
      "Lead agent brief LLM phrasing failed — deterministic fallback used",
    );
  }

  const result = GetLeadAgentBriefResponse.parse({
    headline,
    riskLevel: brief.riskLevel,
    stageGoal,
    actions: brief.actions,
    draftMessage,
    confidence,
    routedToHuman,
    agentDisabled: false,
  });
  await recordAgentRun({
    dealerId,
    agentKey: "pipeline_suggestions",
    runType: "lead_agent_brief",
    inputSource: "leads",
    inputSummary: `Lead #${lead.id} (${lead.phase})`,
    outputSummary: `${result.headline}${llmStatus === "fallback" ? " [deterministic fallback]" : ""}`,
    refType: "lead",
    refId: lead.id,
    latencyMs: Date.now() - briefStartedAt,
  });
  res.json(result);
});

// ---------------------------------------------------------------------------
// Click-to-call (A6) — stub telephony adapter + one call log per call.
// ---------------------------------------------------------------------------

async function leadForDealer(
  leadId: number,
  dealerId: number,
): Promise<Lead | null> {
  const [lead] = await db
    .select()
    .from(leadsTable)
    .where(and(eq(leadsTable.id, leadId), eq(leadsTable.dealerId, dealerId)));
  return lead ?? null;
}

router.get("/leads/:id/calls", async (req, res): Promise<void> => {
  const params = ListLeadCallsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const lead = await leadForDealer(params.data.id, activeDealerId(res));
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }
  const calls = await db
    .select()
    .from(callLogsTable)
    .where(
      and(
        eq(callLogsTable.leadId, lead.id),
        eq(callLogsTable.dealerId, lead.dealerId),
      ),
    )
    .orderBy(desc(callLogsTable.createdAt));
  res.json(ListLeadCallsResponse.parse(calls));
});

router.post("/leads/:id/calls", async (req, res): Promise<void> => {
  const params = CreateLeadCallParams.safeParse(req.params);
  const body = CreateLeadCallBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({
      error: (params.success ? body : params).error?.message ?? "Invalid input",
    });
    return;
  }
  const lead = await leadForDealer(params.data.id, activeDealerId(res));
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }

  // A callback promise must be in the future (dealer-local clock).
  const callbackAt = body.data.callbackAt ? new Date(body.data.callbackAt) : null;
  if (callbackAt && callbackAt.getTime() <= Date.now()) {
    res.status(400).json({ error: "Callback time must be in the future" });
    return;
  }
  if (body.data.status === "callback" && !callbackAt) {
    res.status(400).json({ error: "A callback disposition needs a callback time" });
    return;
  }

  // PENDING-INFRA seam: the adapter is a stub until a real provider exists.
  const session = await telephonyAdapter().placeCall({
    dealerId: lead.dealerId,
    leadId: lead.id,
    toPhone: lead.phone,
    direction: body.data.direction,
  });

  const [call] = await db
    .insert(callLogsTable)
    .values({
      dealerId: lead.dealerId,
      leadId: lead.id,
      direction: body.data.direction,
      status: body.data.status,
      durationSeconds: body.data.durationSeconds ?? null,
      sentiment: body.data.sentiment ?? "neutral",
      notes: body.data.notes?.trim() || null,
      provider: session.provider,
      providerCallId: session.providerCallId,
      callbackAt,
      actor: actorName(res),
    })
    .returning();

  await markLeadContactFromCall(call!);

  // Exactly ONE activity record per call: the call log row above plus a
  // single timeline event that carries outcome + sentiment into the feed.
  const mins =
    call!.durationSeconds != null
      ? ` (${Math.round(call!.durationSeconds / 60)} min)`
      : "";
  const statusLabel = call!.status.replace("_", " ");
  await logLeadEvent(
    lead,
    "call",
    `${call!.direction === "outbound" ? "Outbound" : "Inbound"} call — ${statusLabel}${mins}`,
    `${call!.notes ? `${call!.notes}\n` : ""}Sentiment: ${call!.sentiment}.`,
    actorName(res),
  );

  // A6 call sentiment: when the advisor leaves the score to AURA and there
  // are notes to judge from, the agent runs fire-and-forget (kill-switch and
  // confidence-gated inside; below-floor scores route to human review).
  if (!body.data.sentiment && call!.notes) {
    autoAnalyzeCall(call!.id);
  }

  // Follow-up cadence (24h → +3d → +3d → +7d): unconnected attempts schedule
  // the next touch; a connect closes the cadence; 4 misses suggest closing.
  try {
    await scheduleCadenceAfterCall(lead, call!);
  } catch (err) {
    req.log.error({ err, leadId: lead.id }, "Cadence scheduling failed");
  }

  res.status(201).json(CreateLeadCallResponse.parse(call));
});

// Annotate a call log after the fact — used by the browser-calling flow to
// attach notes + sentiment once the live Twilio call has ended.
router.patch("/leads/:id/calls/:callId", async (req, res): Promise<void> => {
  const params = UpdateLeadCallParams.safeParse(req.params);
  const body = UpdateLeadCallBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({
      error: (params.success ? body : params).error?.message ?? "Invalid input",
    });
    return;
  }
  const lead = await leadForDealer(params.data.id, activeDealerId(res));
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }
  const [existing] = await db
    .select()
    .from(callLogsTable)
    .where(
      and(
        eq(callLogsTable.id, params.data.callId),
        eq(callLogsTable.leadId, lead.id),
        eq(callLogsTable.dealerId, lead.dealerId),
      ),
    );
  if (!existing) {
    res.status(404).json({ error: "Call not found" });
    return;
  }
  const [updated] = await db
    .update(callLogsTable)
    .set({
      ...(body.data.sentiment ? { sentiment: body.data.sentiment } : {}),
      ...(body.data.notes !== undefined
        ? { notes: body.data.notes.trim() || null }
        : {}),
    })
    .where(eq(callLogsTable.id, existing.id))
    .returning();

  // Sentiment loop: when notes land without an explicit sentiment pick, the
  // Sales agent scores the call and notes the summary on the lead.
  if (body.data.notes !== undefined && !body.data.sentiment && updated) {
    autoAnalyzeCall(updated.id);
  }

  res.json(UpdateLeadCallResponse.parse(updated));
});

// Stream the Twilio recording through our own authed, tenancy-scoped proxy —
// the raw Twilio media URL (which needs account credentials) never leaves
// the server.
router.get(
  "/leads/:id/calls/:callId/recording",
  async (req, res): Promise<void> => {
    const params = GetLeadCallRecordingParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const lead = await leadForDealer(params.data.id, activeDealerId(res));
    if (!lead) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    const [call] = await db
      .select()
      .from(callLogsTable)
      .where(
        and(
          eq(callLogsTable.id, params.data.callId),
          eq(callLogsTable.leadId, lead.id),
          eq(callLogsTable.dealerId, lead.dealerId),
        ),
      );
    if (!call || !call.recordingSid) {
      res.status(404).json({ error: "No recording for this call" });
      return;
    }
    try {
      const audio = await fetchRecordingAudio(call.recordingSid);
      if (!audio || audio.length === 0) {
        res.status(502).json({ error: "Could not fetch the recording audio" });
        return;
      }
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader(
        "Content-Disposition",
        `inline; filename="call-${call.id}-recording.mp3"`,
      );
      res.end(audio);
    } catch (err) {
      req.log.error({ err, callId: call.id }, "Failed to fetch call recording");
      res.status(502).json({ error: "Could not fetch the recording audio" });
    }
  },
);

// AI-assist: suggest a sentiment from call notes. Gated behind the Sales
// agent kill switch — paused agent means no LLM calls, manual picker only.
router.post(
  "/leads/:id/calls/suggest-sentiment",
  async (req, res): Promise<void> => {
    const params = SuggestCallSentimentParams.safeParse(req.params);
    const body = SuggestCallSentimentBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({
        error:
          (params.success ? body : params).error?.message ?? "Invalid input",
      });
      return;
    }
    const lead = await leadForDealer(params.data.id, activeDealerId(res));
    if (!lead) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    const [agent] = await db
      .select()
      .from(agentsTable)
      .where(
        and(
          eq(agentsTable.key, "call_sentiment"),
          eq(agentsTable.dealerId, lead.dealerId),
        ),
      );
    if (!agent || agent.status !== "active") {
      res.status(409).json({
        error:
          "The Sales agent is paused — pick the sentiment manually or resume the agent in AI Agents.",
      });
      return;
    }

    try {
      const message = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 200,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `You classify the customer's overall sentiment from a car dealership call note. Respond with ONLY a JSON object like {"sentiment":"positive","rationale":"…"} where sentiment is exactly one of "positive", "neutral", "negative" and rationale is one short sentence.\n\nCall notes:\n${guardUntrusted("call_notes", body.data.notes)}`,
              },
            ],
          },
        ],
      });
      const textBlock = message.content.find((b) => b.type === "text");
      const raw = textBlock && textBlock.type === "text" ? textBlock.text : "";
      const jsonStart = raw.indexOf("{");
      const jsonEnd = raw.lastIndexOf("}");
      if (jsonStart === -1 || jsonEnd === -1) throw new Error("No JSON in reply");
      const parsedJson = JSON.parse(raw.slice(jsonStart, jsonEnd + 1)) as {
        sentiment?: string;
        rationale?: string;
      };
      const sentiment = ["positive", "neutral", "negative"].includes(
        parsedJson.sentiment ?? "",
      )
        ? parsedJson.sentiment
        : "neutral";
      await recordAgentRun({
        dealerId: lead.dealerId,
        agentKey: "call_sentiment",
        runType: "call_sentiment_suggestion",
        inputSource: "leads",
        inputSummary: body.data.notes,
        outputSummary: `Suggested ${sentiment}: ${parsedJson.rationale ?? ""}`,
        refType: "lead",
        refId: lead.id,
      });
      res.json(
        SuggestCallSentimentResponse.parse({
          sentiment,
          rationale: parsedJson.rationale ?? null,
        }),
      );
    } catch (err) {
      req.log.error({ err }, "Call sentiment suggestion failed");
      await recordAgentRun({
        dealerId: lead.dealerId,
        agentKey: "call_sentiment",
        runType: "call_sentiment_suggestion",
        inputSource: "leads",
        refType: "lead",
        refId: lead.id,
        status: "error",
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      res.status(502).json({ error: "The AI service is unavailable" });
    }
  },
);

export default router;
