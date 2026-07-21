import { Router, type IRouter } from "express";
import { eq, desc, and, isNotNull, ne, sql, inArray, type SQL } from "drizzle-orm";
import {
  db,
  leadsTable,
  vehiclesTable,
  usersTable,
  rolesTable,
  dealerUsersTable,
  timelineEventsTable,
  emailLogsTable,
  whatsappMessagesTable,
  dealsTable,
  callLogsTable,
  agentsTable,
  gatesTable,
  quotesTable,
  SOCIAL_SUB_PLATFORMS,
  type Lead,
  type ChecklistStage,
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
  CheckLeadAvailabilityParams,
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
  GenerateLeadQuoteResponse,
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
  SuggestCallSentimentParams,
  SuggestCallSentimentBody,
  SuggestCallSentimentResponse,
  ListLeadSourcesQueryParams,
  ListLeadSourcesResponse,
} from "@workspace/api-zod";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { onLeadCreated, onLeadUpdated } from "../lib/email-triggers";
import { autoAssignLead, stampLeadAssignment } from "../lib/lead-assignment";
import { findOpenDuplicate, mergeIntoExistingLead } from "../lib/lead-dedup";
import { telephonyAdapter } from "../lib/telephony";
import { enqueueEmail, enqueueWhatsapp, notifyUser } from "../lib/email";
import { ensureAccountForLead } from "../lib/accounts";
import { activeDealerId } from "../middlewares/rbac";
import {
  guardUntrusted,
  isAgentEnabled,
  recordAgentRun,
} from "../lib/agent-governance";
import { defaultDivisionId, divisionBelongsToDealer } from "./divisions";
import {
  ownerCalendarContact,
  testDriveCalendarFields,
} from "../lib/calendar";
import { buildQuotePdf } from "../lib/quote-pdf";
import {
  autoQuoteOnLeadCreated,
  autoQuoteOnLeadUpdated,
  generateQuoteForLead,
  quoteById,
  quotePdfPayload,
} from "../lib/quotes";
import { sendWhatsappText, whatsappConfig } from "../lib/whatsapp";
import { ensureLeadSources } from "../lib/lead-sources";
import { getActiveChecklist } from "../lib/stage-checklists";
import {
  findBlockedEditField,
  redactHiddenFields,
} from "../lib/field-permissions";
import {
  afterTestDriveBooked,
  vehicleAvailabilityError,
} from "../lib/test-drive-scheduler";

const router: IRouter = Router();

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

  const filters: SQL[] = [eq(leadsTable.dealerId, activeDealerId(res))];
  if (query.data.divisionId)
    filters.push(eq(leadsTable.divisionId, query.data.divisionId));
  if (query.data.phase) filters.push(eq(leadsTable.phase, query.data.phase));
  if (query.data.status) filters.push(eq(leadsTable.status, query.data.status));

  // RBAC visibility: Sales Advisors see only leads they own; every other
  // role (managers, coordinators, GM) sees the full pipeline.
  const user = res.locals.user;
  if (user && user.roleName === "Sales Advisor") {
    filters.push(eq(leadsTable.ownerUserId, user.id));
  }

  const rows = await db
    .select()
    .from(leadsTable)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(leadsTable.aiScore), desc(leadsTable.createdAt));

  const visible = await redactHiddenFields(user, "leads", rows);
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
  const parsed = CreateLeadBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const dealerId = activeDealerId(res);
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

  const [lead] = await db
    .insert(leadsTable)
    .values({ ...parsed.data, divisionId, dealerId })
    .returning();

  if (lead) onLeadCreated(lead);
  // Quote agent (A3): auto-generate the Code from inventory + tax config.
  if (lead) autoQuoteOnLeadCreated(lead);

  await logLeadEvent(
    lead!,
    "lead_created",
    `Lead created: ${lead!.name}`,
    `Captured via ${lead!.source.replace("_", " ")} and added to the pipeline.`,
    actorName(res),
  );

  // Sales agent routes unowned leads by timestamp-based round robin.
  const assigned = await autoAssignLead(lead!);

  res.status(201).json(
    CreateLeadResponse.parse({
      lead: assigned ?? lead,
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

  const [visible] = await redactHiddenFields(res.locals.user, "leads", [lead]);
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

const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;
const waDigits = (s: string): string => s.replace(/\D/g, "");

/** Fetch the lead's WhatsApp transcript (by lead id, plus phone fallback). */
async function leadWhatsappMessages(lead: Lead) {
  const rows = await db
    .select()
    .from(whatsappMessagesTable)
    .where(eq(whatsappMessagesTable.leadId, lead.id))
    .orderBy(whatsappMessagesTable.createdAt, whatsappMessagesTable.id);
  return rows;
}

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

  const rows = await leadWhatsappMessages(lead);
  const window = replyWindow(rows);
  const configured = !!whatsappConfig();
  let blocked: string | null = null;
  if (rows.length === 0) blocked = "No WhatsApp conversation on this lead yet.";
  else if (!configured)
    blocked = "WhatsApp sending is not configured for this dealership.";
  else if (!window.open)
    blocked =
      "The 24-hour reply window has closed. It reopens when the customer messages again.";

  res.json(
    GetLeadWhatsappThreadResponse.parse({
      messages: rows.map((r) => ({
        id: r.id,
        direction: r.direction,
        body: r.body,
        actor: r.actor,
        createdAt: r.createdAt,
      })),
      canReply: rows.length > 0 && configured && window.open,
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

  const rows = await leadWhatsappMessages(lead);
  // Reply to the number the customer actually chats from (transcript phone),
  // falling back to the lead's stored mobile.
  const to = rows.length > 0 ? rows[rows.length - 1]!.phone : waDigits(lead.phone ?? "");
  if (!to) {
    res
      .status(422)
      .json({ error: "This lead has no WhatsApp number to reply to." });
    return;
  }
  const cfg = whatsappConfig();
  if (!cfg) {
    res.status(422).json({
      error: "WhatsApp sending is not configured for this dealership.",
    });
    return;
  }
  const window = replyWindow(rows);
  if (!window.open) {
    res.status(422).json({
      error:
        "The 24-hour reply window has closed. It reopens when the customer messages again.",
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

  await logLeadEvent(
    lead,
    "whatsapp_message",
    `WhatsApp reply sent to ${lead.name}`,
    body.data.text,
    actor,
  );

  res.status(201).json(
    SendLeadWhatsappReplyResponse.parse({
      id: queued.id,
      direction: "out",
      body: body.data.text,
      actor,
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
        sql`${emailLogsTable.payload} ->> 'quoteRef' LIKE ${`Q-${leadId}-%`}`,
      ),
    )
    .orderBy(desc(emailLogsTable.id))
    .limit(1);

  // Fresh (never-emailed) quotes are dated today so validity isn't already expired.
  const today = new Date();
  const fallbackRef = `Q-${lead.id}-${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;

  return {
    lead,
    vehicle: vehicle ?? null,
    quoteRef: log?.payload?.quoteRef || fallbackRef,
    sentPayload: log?.payload ?? null,
    sentAt: log?.sentAt ?? null,
  };
}

const quoteMoney = (n: number) =>
  `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

const quoteLongDate = (d: Date) =>
  d.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

/** Build a fresh quote payload from inventory when no emailed quote exists. */
function freshQuotePayload(
  lead: Lead,
  vehicle: typeof vehiclesTable.$inferSelect,
  quoteRef: string,
): Record<string, string> {
  const issued = new Date();
  const validUntil = new Date(issued.getTime() + 14 * 24 * 60 * 60 * 1000);
  return {
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
    issuedOn: quoteLongDate(issued),
    validUntil: quoteLongDate(validUntil),
  };
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

  if (!ctx.vehicle && !ctx.sentPayload) {
    res.json(GetLeadQuoteResponse.parse({ available: false }));
    return;
  }

  const payload =
    ctx.sentPayload ??
    (ctx.vehicle ? freshQuotePayload(ctx.lead, ctx.vehicle, ctx.quoteRef) : {});
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

  const payload =
    ctx.sentPayload ??
    (ctx.vehicle
      ? freshQuotePayload(ctx.lead, ctx.vehicle, ctx.quoteRef)
      : null);
  if (!payload) {
    res
      .status(404)
      .json({ error: "No vehicle of interest on file — no quote available" });
    return;
  }

  const pdf = await buildQuotePdf(payload);
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
  res.json(ListLeadQuotesResponse.parse(rows));
});

router.post("/leads/:id/quotes", async (req, res): Promise<void> => {
  const params = GenerateLeadQuoteParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
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
  });
  if (!quote) {
    res.status(422).json({
      error:
        "This lead has no vehicle of interest on file — pick a vehicle first, then generate the Code.",
    });
    return;
  }
  res.status(201).json(GenerateLeadQuoteResponse.parse(quote));
});

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
    const pdf = await buildQuotePdf(quotePdfPayload(quote));
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

    const channel = body.data.channel;
    if (channel === "email") {
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
        data: quotePdfPayload(quote),
      });
    } else {
      const to = waDigits(lead.phone ?? "");
      if (!to) {
        res
          .status(422)
          .json({ error: "This lead has no phone number for WhatsApp." });
        return;
      }
      const cfg = whatsappConfig();
      if (!cfg) {
        res.status(422).json({
          error: "WhatsApp sending is not configured for this dealership.",
        });
        return;
      }
      const taxText =
        quote.taxLines.length > 0
          ? quote.taxLines
              .map((l) => `• ${l.name}: $${l.amount.toLocaleString("en-US")}`)
              .join("\n")
          : "• No taxes applicable";
      const text =
        `Hi ${quote.customerName}, here is your estimate ${quote.quoteNumber} (rev ${quote.version}) from AURA:\n\n` +
        `${quote.modelYear} ${quote.vehicleLine}${quote.color ? ` — ${quote.color}` : ""}\n` +
        `Base price: $${quote.basePrice.toLocaleString("en-US")}\n${taxText}\n` +
        `Total: $${quote.total.toLocaleString("en-US")}\n\n` +
        `Valid until ${quote.validUntil}. Reply here with any questions!`;
      try {
        await sendWhatsappText(cfg, to, text);
      } catch {
        res.status(502).json({
          error: "WhatsApp could not deliver the message. Try again.",
        });
        return;
      }
    }

    await db
      .update(quotesTable)
      .set({ sentAt: new Date(), sentVia: channel })
      .where(eq(quotesTable.id, quote.id));
    await db
      .update(leadsTable)
      .set({ quotationSent: true })
      .where(
        and(eq(leadsTable.id, lead.id), eq(leadsTable.dealerId, lead.dealerId)),
      );
    await logLeadEvent(
      lead,
      "quote_sent",
      `Code ${quote.quoteNumber} sent via ${channel === "email" ? "email" : "WhatsApp"}`,
      `Rev ${quote.version} — total $${quote.total.toLocaleString("en-US")} sent to the customer.`,
      actorName(res),
    );
    res.json(SendLeadQuoteResponse.parse({ ok: true, channel }));
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
      phase: existing.phase === "aware" ? "consider" : existing.phase,
      ...(existing.phase === "aware" ? { stageEnteredAt: new Date() } : {}),
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

  await notifyUser({
    userId: advisor.id,
    dealerId: lead!.dealerId,
    type: "assignment",
    title: `Lead assigned: ${lead!.name}`,
    body: "A new lead is now yours — make first contact and update the status.",
    link: "/pipeline",
  });

  if (lead!.email) {
    const vehicle = await vehicleLabel(lead!.dealerId, lead!.interestedVehicleId);
    await enqueueEmail({
      template: "lead_assignment",
      to: lead!.email,
      dealerId: lead!.dealerId,
      customerId: lead!.customerId,
      data: { advisor: advisorName, vehicle: vehicle ?? "" },
    });
  }

  res.json(GetLeadResponse.parse(lead));
});

// Gated stage advance: each target stage has a checklist that must be met
// before the lead moves forward. Unmet criteria come back as a 422 so the
// client can render a "Review & Advance" checklist.
const ADVANCE_TARGET_PHASE = {
  qualified: "consider",
  test_drive: "engage",
  negotiation: "negotiate",
  sold: "won",
} as const;
const PHASE_ORDER = ["aware", "consider", "engage", "negotiate", "won"];
const REVIEW_STAGE_LABEL: Record<string, string> = {
  qualified: "Qualification",
  test_drive: "Test Drive",
  negotiation: "Negotiation",
  sold: "Booking Confirmed",
};
// Who is accountable for clearing each checklist item — shown as owner chips
// in the Run Review stepper.
const CHECK_OWNER: Record<string, string> = {
  contact_details: "Sales Advisor",
  vehicle_selected: "Sales Advisor",
  budget_discussed: "Sales Advisor",
  test_drive_booked: "Sales Advisor",
  licence_on_file: "Customer",
  waiver_signed: "Customer",
  vehicle_available: "Inventory",
  test_drive_completed: "Sales Advisor",
  deal_created: "Sales Manager",
  deal_exists: "Sales Manager",
  deposit_taken: "Finance",
  finance_approved: "Finance",
};

// Built-in check implementations, keyed by checklist item key. Shared by the
// gated advance and the Run Review evaluation so both always agree.
function buildStageChecks(
  lead: Lead,
  dealerId: number,
  leadDeals: { depositPaid: boolean | null }[],
): Record<string, () => Promise<boolean> | boolean> {
  const deal = leadDeals[0];
  return {
    contact_details: () => Boolean(lead.email || lead.phone),
    vehicle_selected: () => Boolean(lead.interestedVehicleId),
    budget_discussed: () => Boolean(lead.budgetFinancing),
    test_drive_booked: () => Boolean(lead.testDriveAt),
    licence_on_file: () => Boolean(lead.testDriveLicence),
    waiver_signed: () => Boolean(lead.testDriveWaiver),
    vehicle_available: async () => {
      if (!lead.interestedVehicleId) return true;
      const [v] = await db
        .select({ status: vehiclesTable.status })
        .from(vehiclesTable)
        .where(
          and(
            eq(vehiclesTable.id, lead.interestedVehicleId),
            eq(vehiclesTable.dealerId, dealerId),
          ),
        );
      return !v || v.status === "available" || v.status === "reserved";
    },
    test_drive_completed: () => Boolean(lead.testDriveAt),
    deal_created: () => leadDeals.length > 0,
    deal_exists: () => Boolean(deal),
    deposit_taken: () =>
      Boolean((deal && deal.depositPaid) || lead.reservationFeePaid),
    finance_approved: () =>
      Boolean(lead.financingQualified || lead.purchaseType === "cash"),
  };
}

// Phase-wise review: evaluate every stage gate's checklist for this lead so
// the client can run a stepper review (pass / needs attention + owners).
router.get("/leads/:id/review", async (req, res): Promise<void> => {
  const params = GetLeadReviewParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
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
  const graGates =
    dealIds.length > 0
      ? await db
          .select({ status: gatesTable.status })
          .from(gatesTable)
          .where(
            and(
              eq(gatesTable.dealerId, dealerId),
              eq(gatesTable.type, "gra_filing"),
              eq(gatesTable.refType, "deal"),
              inArray(gatesTable.refId, dealIds),
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
        label: "GRA duty filing approved",
        met: graFiled,
        owner: "GRA / Compliance",
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
  res.json(
    GetLeadReviewResponse.parse({
      leadId: lead.id,
      phase: lead.phase,
      nextStage: next ? next.stage : null,
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

  // AUTO-DESK AGENT: when a lead advances into Negotiation with a vehicle
  // selected but no deal on file, the sales agent desks a draft deal
  // automatically (vehicle price, no discount) so the advisor negotiates from
  // real numbers instead of being blocked by the deal_created gate. Manual
  // desking by the advisor at any earlier point takes precedence — the agent
  // only acts when NO deal exists. Governed: per-dealer kill switch + run
  // record + audit log, per platform agent-governance rules.
  if (
    toStage === "negotiation" &&
    leadDeals.length === 0 &&
    lead.interestedVehicleId &&
    (await isAgentEnabled(dealerId, "sales"))
  ) {
    const startedAt = Date.now();
    const [vehicle] = await db
      .select()
      .from(vehiclesTable)
      .where(
        and(
          eq(vehiclesTable.id, lead.interestedVehicleId),
          eq(vehiclesTable.dealerId, dealerId),
        ),
      );
    if (vehicle) {
      const [autoDeal] = await db
        .insert(dealsTable)
        .values({
          dealerId,
          leadId: lead.id,
          customerId: lead.customerId ?? null,
          customerName: lead.name,
          vehicleId: vehicle.id,
          vehiclePrice: vehicle.price,
          discount: 0,
          divisionId:
            vehicle.divisionId ?? (await defaultDivisionId(dealerId)),
          salesAdvisor: lead.assignedTo ?? null,
        })
        .returning();
      if (autoDeal) {
        leadDeals.push(autoDeal);
        await db.insert(timelineEventsTable).values({
          dealerId,
          customerId: lead.customerId,
          domain: "leads",
          kind: "deal_created",
          title: "Deal auto-desked by AURA",
          detail: `Draft deal #${autoDeal.id} created at the vehicle's listed price when the lead entered Negotiation — review and adjust the numbers.`,
          actor: "AURA Sales Agent",
          isAgent: true,
          refType: "lead",
          refId: lead.id,
        });
        await recordAgentRun({
          dealerId,
          agentKey: "sales",
          runType: "auto_desk_deal",
          inputSource: "stage_advance",
          inputSummary: `Lead #${lead.id} advanced to Negotiation with no deal on file`,
          outputSummary: `Drafted deal #${autoDeal.id} at listed price for vehicle #${vehicle.id}`,
          refType: "deal",
          refId: autoDeal.id,
          latencyMs: Date.now() - startedAt,
          mutation: true,
        });
      }
    }
  }

  // Gate criteria come from the dealer's ACTIVE checklist config (versioned,
  // Settings → Stage Gates). Each item key maps to a built-in check; admins
  // can toggle items on/off and relabel them without a deploy.
  const checklist = await getActiveChecklist(dealerId, toStage as ChecklistStage);
  const checks = buildStageChecks(lead, dealerId, leadDeals);
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

  const STAGE_LABEL: Record<string, string> = {
    qualified: "Qualified",
    test_drive: "Test Drive",
    negotiation: "Negotiation",
    sold: "Sold",
  };
  await logLeadEvent(
    updated!,
    "stage_advanced",
    `Advanced to ${STAGE_LABEL[toStage]}`,
    "All stage checklist criteria met.",
    actorName(res),
  );

  res.json(GetLeadResponse.parse(updated));
});

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

  // One drive at a time: block scheduling on top of a slot that any other
  // lead already holds (customers self-book via their public invite link).
  const [conflict] = await db
    .select({ id: leadsTable.id, name: leadsTable.name })
    .from(leadsTable)
    .where(
      and(eq(leadsTable.testDriveAt, when), ne(leadsTable.id, params.data.id)),
    );
  if (conflict) {
    res.status(409).json({
      error: `That time slot is already booked (${conflict.name}) — pick another time`,
    });
    return;
  }

  // A10 — the vehicle itself must still be available for a drive.
  {
    const checkLead = {
      ...existing,
      interestedVehicleId:
        parsed.data.vehicleId ?? existing.interestedVehicleId,
    };
    const vehicleError = await vehicleAvailabilityError(checkLead);
    if (vehicleError) {
      res.status(409).json({ error: vehicleError });
      return;
    }
  }

  const [lead] = await db
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
        existing.phase === "aware" || existing.phase === "consider"
          ? "engage"
          : existing.phase,
      ...(existing.phase === "aware" || existing.phase === "consider"
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

  // A booked test drive promotes the lead to an account.
  lead!.customerId = await ensureAccountForLead(lead!);

  const vehicle = await vehicleLabel(lead!.dealerId, lead!.interestedVehicleId);
  const dateStr = when.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const timeStr = when.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });

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
  const [lead] = await db
    .update(leadsTable)
    .set({
      purchaseType: choice,
      status: "converted",
      phase: "negotiate",
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

router.patch("/leads/:id", async (req, res): Promise<void> => {
  const params = UpdateLeadParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateLeadBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

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
      ),
    );
  if (!before) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }

  const [lead] = await db
    .update(leadsTable)
    .set({
      ...parsed.data,
      ...(parsed.data.phase && parsed.data.phase !== before.phase
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

  // Pre-booking blocks the unit: taking the reservation fee reserves the
  // interested vehicle so it can't be double-sold from inventory.
  if (
    parsed.data.reservationFeePaid === true &&
    !before.reservationFeePaid &&
    lead?.interestedVehicleId
  ) {
    const [reserved] = await db
      .update(vehiclesTable)
      .set({ status: "reserved" })
      .where(
        and(
          eq(vehiclesTable.id, lead.interestedVehicleId),
          eq(vehiclesTable.dealerId, activeDealerId(res)),
          eq(vehiclesTable.status, "available"),
        ),
      )
      .returning({ id: vehiclesTable.id });
    if (reserved) {
      await logLeadEvent(
        lead,
        "vehicle_reserved",
        "Unit blocked in inventory",
        `${actorName(res)} recorded the reservation fee — the interested vehicle is now reserved.`,
        actorName(res),
      );
    }
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
      "phase_updated",
      `Stage advanced`,
      `${actorName(res)} moved the lead from ${before.phase} to ${parsed.data.phase}.`,
      actorName(res),
    );
  }

  if (before) onLeadUpdated(before, lead);
  // Quote agent (A3): regenerate the Code when a pricing-relevant field
  // (vehicle, color, variant, financing) changed and a Code already exists.
  if (before && lead) autoQuoteOnLeadUpdated(before, lead);

  res.json(UpdateLeadResponse.parse(lead));
});

router.delete("/leads/:id", async (req, res): Promise<void> => {
  const params = DeleteLeadParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [lead] = await db
    .delete(leadsTable)
    .where(
      and(
        eq(leadsTable.id, params.data.id),
        eq(leadsTable.dealerId, activeDealerId(res)),
      ),
    )
    .returning();

  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }

  res.sendStatus(204);
});

// ---------------------------------------------------------------------------
// AI agent brief — per-lead next best actions + draft follow-up
// ---------------------------------------------------------------------------
const BRIEF_STAGE_GOAL: Record<string, string> = {
  aware: "make first contact within 24 hours and qualify interest",
  consider: "log the first call, capture budget and financing preference",
  engage: "book the test drive, qualify financing, and send the quotation",
  negotiate: "secure the reservation fee and lock the selected model",
  won: "allocate the unit, clear payment, and deliver flawlessly",
  lost: "understand the loss and plan re-engagement",
};

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

  if (!(await isAgentEnabled(dealerId, "sales"))) {
    await recordAgentRun({
      dealerId,
      agentKey: "sales",
      runType: "lead_agent_brief",
      inputSource: "leads",
      refType: "lead",
      refId: lead.id,
      status: "blocked",
      errorMessage: "Agent paused by dealer kill switch",
    });
    res.status(409).json({
      error: "The Sales agent is paused — resume it in AI Agents to use briefs.",
    });
    return;
  }

  const stageGoal = BRIEF_STAGE_GOAL[lead.phase] ?? "advance the relationship";
  const facts = [
    `Name: ${lead.name}; phase: ${lead.phase}; status: ${lead.status}; AI score: ${lead.aiScore}; priority: ${lead.priority}; channel: ${lead.channel}.`,
    `Assigned to: ${lead.assignedTo ?? "UNASSIGNED"}.`,
    `First contact logged: ${lead.contactedDate ? "yes" : "NO"}; test drive: ${lead.testDriveAt ? `booked ${lead.testDriveAt.toISOString().slice(0, 10)}` : "not booked"}.`,
    `Financing qualified: ${lead.financingQualified ? "yes" : "no"}; budget/financing preference: ${lead.budgetFinancing ?? "unknown"}.`,
    `Quotation sent: ${lead.quotationSent ? "yes" : "no"}; reservation fee paid: ${lead.reservationFeePaid ? "yes" : "no"}.`,
    vehicle
      ? `Interested vehicle: ${vehicle.year} ${vehicle.make} ${vehicle.model} at ${vehicle.price}.`
      : `No vehicle of interest recorded.`,
    deals.length
      ? `Linked deal stage: ${deals.map((d) => d.stage).join(", ")}.`
      : `No deal opened yet.`,
    lead.notes ? `Notes: ${guardUntrusted("lead_notes", lead.notes, 300)}` : "",
    timeline.length
      ? `Recent activity: ${timeline.map((t) => t.title).join("; ")}.`
      : "No recorded activity yet.",
  ]
    .filter(Boolean)
    .join("\n");

  const prompt = [
    `You are AURA, the agentic sales intelligence of an ultra-premium automotive dealership.`,
    `Analyse this single lead. The current stage goal is to ${stageGoal}.`,
    facts,
    ``,
    `Return ONLY a JSON object (no markdown) with exactly these keys:`,
    `{`,
    `  "headline": string,                       // one confident sentence on where this lead stands`,
    `  "riskLevel": "low" | "medium" | "high",   // risk of losing this lead`,
    `  "actions": [                              // 2 to 4 next best actions, most important first`,
    `    { "title": string, "detail": string, "priority": "high" | "medium" | "low", "leadName": null }`,
    `  ],`,
    `  "draftMessage": string                    // a short, warm, ready-to-send follow-up message to the customer (no placeholders except their first name)`,
    `}`,
    `Ground every action in the facts above (missing checklist items first). Luxury-brand tone: warm, confident, concise.`,
  ].join("\n");

  const briefStartedAt = Date.now();
  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1200,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    });
    const textBlock = message.content.find((b) => b.type === "text");
    const raw = textBlock && textBlock.type === "text" ? textBlock.text : "";
    const jsonStart = raw.indexOf("{");
    const jsonEnd = raw.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd === -1) {
      req.log.error({ raw }, "Lead agent brief returned no JSON object");
      res.status(502).json({ error: "The agent could not read this lead" });
      return;
    }
    let candidate: Record<string, unknown>;
    try {
      candidate = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
    } catch {
      req.log.error({ raw }, "Lead agent brief returned invalid JSON");
      res.status(502).json({ error: "The agent could not read this lead" });
      return;
    }
    const result = GetLeadAgentBriefResponse.safeParse({
      headline: candidate.headline,
      riskLevel: candidate.riskLevel,
      stageGoal,
      actions: candidate.actions,
      draftMessage: candidate.draftMessage,
    });
    if (!result.success) {
      req.log.error(
        { issues: result.error.issues },
        "Lead agent brief failed validation",
      );
      res.status(502).json({ error: "The agent returned an unexpected shape" });
      return;
    }
    await recordAgentRun({
      dealerId,
      agentKey: "sales",
      runType: "lead_agent_brief",
      inputSource: "leads",
      inputSummary: `Lead #${lead.id} (${lead.phase})`,
      outputSummary: result.data.headline,
      refType: "lead",
      refId: lead.id,
      latencyMs: Date.now() - briefStartedAt,
    });
    res.json(result.data);
  } catch (err) {
    req.log.error({ err }, "Lead agent brief LLM call failed");
    await recordAgentRun({
      dealerId,
      agentKey: "sales",
      runType: "lead_agent_brief",
      inputSource: "leads",
      refType: "lead",
      refId: lead.id,
      status: "error",
      errorMessage: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - briefStartedAt,
    });
    res.status(502).json({ error: "The agent service is unavailable" });
  }
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
      sentiment: body.data.sentiment,
      notes: body.data.notes?.trim() || null,
      provider: session.provider,
      providerCallId: session.providerCallId,
      actor: actorName(res),
    })
    .returning();

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
  res.json(UpdateLeadCallResponse.parse(updated));
});

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
          eq(agentsTable.key, "sales"),
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
        agentKey: "sales",
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
        agentKey: "sales",
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
