import { Router, type IRouter } from "express";
import { eq, desc, and, isNotNull, ne, sql, type SQL } from "drizzle-orm";
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
import { defaultDivisionId, divisionBelongsToDealer } from "./divisions";
import {
  ownerCalendarContact,
  testDriveCalendarFields,
} from "../lib/calendar";
import { buildQuotePdf } from "../lib/quote-pdf";
import { whatsappConfig } from "../lib/whatsapp";
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

  // Gate criteria come from the dealer's ACTIVE checklist config (versioned,
  // Settings → Stage Gates). Each item key maps to a built-in check; admins
  // can toggle items on/off and relabel them without a deploy.
  const checklist = await getActiveChecklist(dealerId, toStage as ChecklistStage);
  const deal = leadDeals[0];
  const checks: Record<string, () => Promise<boolean> | boolean> = {
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
    lead.notes ? `Notes: ${lead.notes.slice(0, 300)}` : "",
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
    res.json(result.data);
  } catch (err) {
    req.log.error({ err }, "Lead agent brief LLM call failed");
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
                text: `You classify the customer's overall sentiment from a car dealership call note. Respond with ONLY a JSON object like {"sentiment":"positive","rationale":"…"} where sentiment is exactly one of "positive", "neutral", "negative" and rationale is one short sentence.\n\nCall notes:\n${body.data.notes}`,
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
      res.json(
        SuggestCallSentimentResponse.parse({
          sentiment,
          rationale: parsedJson.rationale ?? null,
        }),
      );
    } catch (err) {
      req.log.error({ err }, "Call sentiment suggestion failed");
      res.status(502).json({ error: "The AI service is unavailable" });
    }
  },
);

export default router;
