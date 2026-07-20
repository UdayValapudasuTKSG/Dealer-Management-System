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
  type Lead,
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
  GetLeadQuoteParams,
  GetLeadQuoteResponse,
  DownloadLeadQuotePdfParams,
  GetLeadWhatsappThreadParams,
  GetLeadWhatsappThreadResponse,
  SendLeadWhatsappReplyParams,
  SendLeadWhatsappReplyBody,
  SendLeadWhatsappReplyResponse,
} from "@workspace/api-zod";
import { onLeadCreated, onLeadUpdated } from "../lib/email-triggers";
import { autoAssignLead } from "../lib/lead-assignment";
import { enqueueEmail, notifyUser } from "../lib/email";
import { ensureAccountForLead } from "../lib/accounts";
import { activeDealerId } from "../middlewares/rbac";
import {
  ownerCalendarContact,
  testDriveCalendarFields,
} from "../lib/calendar";
import { buildQuotePdf } from "../lib/quote-pdf";
import { sendWhatsappText, whatsappConfig } from "../lib/whatsapp";

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

  res.json(ListLeadsResponse.parse(rows));
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

  const [lead] = await db
    .insert(leadsTable)
    .values({ ...parsed.data, dealerId: activeDealerId(res) })
    .returning();

  if (lead) onLeadCreated(lead);

  await logLeadEvent(
    lead!,
    "lead_created",
    `Lead created: ${lead!.name}`,
    `Captured via ${lead!.source.replace("_", " ")} and added to the pipeline.`,
    actorName(res),
  );

  // Sales agent routes unowned leads to the least-loaded advisor.
  const assigned = await autoAssignLead(lead!);

  res.status(201).json(GetLeadResponse.parse(assigned ?? lead));
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

  res.json(GetLeadResponse.parse(lead));
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
  try {
    await sendWhatsappText(cfg, to, body.data.text);
  } catch {
    res
      .status(502)
      .json({ error: "WhatsApp could not deliver the message. Try again." });
    return;
  }

  const [saved] = await db
    .insert(whatsappMessagesTable)
    .values({
      dealerId: lead.dealerId,
      leadId: lead.id,
      phone: to,
      direction: "out",
      body: body.data.text,
      actor,
    })
    .returning();

  await logLeadEvent(
    lead,
    "whatsapp_message",
    `WhatsApp reply sent to ${lead.name}`,
    body.data.text,
    actor,
  );

  res.status(201).json(
    SendLeadWhatsappReplyResponse.parse({
      id: saved!.id,
      direction: saved!.direction,
      body: saved!.body,
      actor: saved!.actor,
      createdAt: saved!.createdAt,
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

  if (toStage === "qualified") {
    if (!lead.email && !lead.phone) unmet.push("Contact details (email or phone) captured");
    if (!lead.interestedVehicleId) unmet.push("Vehicle of interest selected");
    if (!lead.budgetFinancing) unmet.push("Budget / financing discussed");
  } else if (toStage === "test_drive") {
    if (!lead.testDriveAt) unmet.push("Test-drive slot booked");
    if (!lead.testDriveLicence) unmet.push("Driver's licence number on file");
    if (!lead.testDriveWaiver) unmet.push("Test-drive waiver signed");
    if (lead.interestedVehicleId) {
      const [v] = await db
        .select({ status: vehiclesTable.status })
        .from(vehiclesTable)
        .where(
          and(
            eq(vehiclesTable.id, lead.interestedVehicleId),
            eq(vehiclesTable.dealerId, dealerId),
          ),
        );
      if (v && v.status !== "available" && v.status !== "reserved")
        unmet.push("Interested vehicle is not available for a drive");
    }
  } else if (toStage === "negotiation") {
    if (!lead.testDriveAt) unmet.push("Test drive completed (or explicitly booked)");
    if (leadDeals.length === 0) unmet.push("Draft deal numbers entered (create a deal)");
  } else if (toStage === "sold") {
    const deal = leadDeals[0];
    if (!deal) unmet.push("A deal must exist before marking sold");
    if (deal && !deal.depositPaid && !lead.reservationFeePaid)
      unmet.push("Deposit taken (deal deposit or reservation fee)");
    if (!lead.financingQualified && lead.purchaseType !== "cash")
      unmet.push("Finance approved or cash purchase verified");
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

export default router;
