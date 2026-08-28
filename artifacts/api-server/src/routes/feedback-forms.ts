import { Router, type IRouter, type Response } from "express";
import { and, desc, eq, gte, ilike, inArray, isNull, lte, not, or, sql, type SQL } from "drizzle-orm";
import {
  db,
  feedbackFormsTable,
  feedbackInvitationsTable,
  leadsTable,
  emailLogsTable,
  timelineEventsTable,
  type FeedbackForm,
  type FeedbackInvitation,
  type FeedbackQuestion,
  type Lead,
} from "@workspace/db";
import {
  CreateFeedbackFormBody,
  UpdateFeedbackFormBody,
  UpdateFeedbackFormParams,
  GetFeedbackFormParams,
  SetFeedbackFormStatusBody,
  SetFeedbackFormStatusParams,
  DuplicateFeedbackFormParams,
  PreviewFeedbackRecipientsBody,
  SendFeedbackFormBody,
  SendFeedbackFormParams,
  ListFeedbackFormInvitationsParams,
  GetLeadFeedbackParams,
} from "@workspace/api-zod";
import { activeDealerId } from "../middlewares/rbac";
import { enqueueEmail, enqueueWhatsapp, isWhatsappOptedOut } from "../lib/email";
import { feedbackFormUrl } from "../lib/email-triggers";

// ---------------------------------------------------------------------------
// GM-only custom feedback forms: reusable builder + filtered bulk delivery.
// Every administration/send/read endpoint here is restricted to General
// Managers (or super admins); the lead-scoped history endpoint follows the
// leads module RBAC and is additionally dealer-scoped.
// ---------------------------------------------------------------------------

const router: IRouter = Router();

function isGeneralManager(res: Response): boolean {
  const user = res.locals.user;
  const dealerId = activeDealerId(res);
  const membership = user?.dealers?.find(
    (d: { dealerId: number }) => d.dealerId === dealerId,
  );
  return (
    user?.isSuperAdmin === true ||
    membership?.isGeneralManager === true ||
    membership?.roleName === "General Manager" ||
    user?.roleName === "General Manager"
  );
}

function requireGM(res: Response): boolean {
  if (isGeneralManager(res)) return true;
  res.status(403).json({ error: "General Manager only" });
  return false;
}

// --- question validation ----------------------------------------------------

const QUESTION_TYPES = new Set([
  "text",
  "long_text",
  "single_choice",
  "multi_choice",
  "star_rating",
]);

function validateQuestions(questions: FeedbackQuestion[]): string | null {
  const ids = new Set<string>();
  for (const q of questions) {
    if (!q.id || ids.has(q.id)) return "Question ids must be unique";
    ids.add(q.id);
    if (!QUESTION_TYPES.has(q.type)) return `Unsupported question type: ${q.type}`;
    if (!q.label?.trim()) return "Every question needs a label";
    if (q.type === "single_choice" || q.type === "multi_choice") {
      const opts = (q.options ?? []).map((o) => o.trim()).filter(Boolean);
      if (opts.length < 2) return `"${q.label}" needs at least two choices`;
      if (new Set(opts).size !== opts.length)
        return `"${q.label}" has duplicate choices`;
    }
    if (q.type === "star_rating") {
      const max = q.maxStars ?? 5;
      if (max < 3 || max > 10) return "Star ratings support 3–10 stars";
    }
  }
  return null;
}

function normalizeQuestions(questions: FeedbackQuestion[]): FeedbackQuestion[] {
  return questions.map((q) => ({
    id: q.id,
    type: q.type,
    label: q.label.trim(),
    required: !!q.required,
    ...(q.type === "single_choice" || q.type === "multi_choice"
      ? { options: (q.options ?? []).map((o) => o.trim()).filter(Boolean) }
      : {}),
    ...(q.type === "star_rating" ? { maxStars: q.maxStars ?? 5 } : {}),
  }));
}

// --- serialization -----------------------------------------------------------

async function formCounts(
  dealerId: number,
  formIds: number[],
): Promise<Map<number, { sent: number; responded: number }>> {
  const map = new Map<number, { sent: number; responded: number }>();
  if (!formIds.length) return map;
  const rows = await db
    .select({
      formId: feedbackInvitationsTable.formId,
      sent: sql<number>`count(*)::int`,
      responded: sql<number>`count(*) filter (where ${feedbackInvitationsTable.submittedAt} is not null)::int`,
    })
    .from(feedbackInvitationsTable)
    .where(
      and(
        eq(feedbackInvitationsTable.dealerId, dealerId),
        inArray(feedbackInvitationsTable.formId, formIds),
      ),
    )
    .groupBy(feedbackInvitationsTable.formId);
  for (const r of rows) map.set(r.formId, { sent: r.sent, responded: r.responded });
  return map;
}

function serializeForm(
  f: FeedbackForm,
  counts: { sent: number; responded: number },
) {
  return {
    id: f.id,
    name: f.name,
    description: f.description ?? null,
    status: f.status,
    questions: (f.questions ?? []) as FeedbackQuestion[],
    sentCount: counts.sent,
    responseCount: counts.responded,
    createdBy: f.createdBy ?? null,
    createdAt: f.createdAt.toISOString(),
    updatedAt: f.updatedAt.toISOString(),
  };
}

async function serializeInvitations(
  invitations: Array<FeedbackInvitation & { leadName?: string | null }>,
) {
  const logIds = invitations
    .flatMap((i) => [i.emailLogId, i.whatsappLogId])
    .filter((x): x is number => x != null);
  const logs = logIds.length
    ? await db
        .select({ id: emailLogsTable.id, status: emailLogsTable.status })
        .from(emailLogsTable)
        .where(inArray(emailLogsTable.id, logIds))
    : [];
  const statusById = new Map(logs.map((l) => [l.id, l.status]));
  return invitations.map((i) => ({
    id: i.id,
    formId: i.formId,
    leadId: i.leadId,
    leadName: i.leadName ?? null,
    formName: i.formName,
    status: i.status,
    channels: (i.channels ?? []) as string[],
    delivery: [
      ...(i.emailLogId != null
        ? [{ channel: "email", status: statusById.get(i.emailLogId) ?? "queued" }]
        : []),
      ...(i.whatsappLogId != null
        ? [
            {
              channel: "whatsapp",
              status: statusById.get(i.whatsappLogId) ?? "queued",
            },
          ]
        : []),
    ],
    questionsSnapshot: (i.questionsSnapshot ?? []) as FeedbackQuestion[],
    answers: (i.answers ?? null) as Record<string, unknown> | null,
    expiresAt: i.expiresAt.toISOString(),
    submittedAt: i.submittedAt ? i.submittedAt.toISOString() : null,
    createdAt: i.createdAt.toISOString(),
  }));
}

async function getForm(
  dealerId: number,
  id: number,
): Promise<FeedbackForm | null> {
  const [form] = await db
    .select()
    .from(feedbackFormsTable)
    .where(
      and(eq(feedbackFormsTable.id, id), eq(feedbackFormsTable.dealerId, dealerId)),
    );
  return form ?? null;
}

// --- Jira-style lead filters --------------------------------------------------

type LeadFilter = { field: string; operator: string; values: string[] };

function dateFrom(v: string | undefined, endOfDay: boolean): Date | null {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  return new Date(`${v}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}`);
}

/** Builds dealer-scoped SQL conditions for the composable lead filters. */
/** Operators each filter field supports — anything else is a 422, never a
 * silent reinterpretation (this expression selects a send audience). */
const FIELD_OPERATORS: Record<string, readonly string[]> = {
  phase: ["is", "is_not", "is_any_of"],
  status: ["is", "is_not", "is_any_of"],
  source: ["is", "is_not", "is_any_of"],
  owner: ["is", "is_not", "contains"],
  division: ["is", "is_not", "is_any_of"],
  created: ["on_or_after", "on_or_before"],
  vehicleInterest: ["contains"],
};

function filterConditions(filters: LeadFilter[]): SQL[] | { error: string } {
  const conds: SQL[] = [];
  for (const f of filters) {
    const allowed = FIELD_OPERATORS[f.field];
    if (!allowed) return { error: `Unsupported filter field: ${f.field}` };
    if (!allowed.includes(f.operator)) {
      return {
        error: `Operator "${f.operator}" is not valid for field "${f.field}" (allowed: ${allowed.join(", ")})`,
      };
    }
    const values = (f.values ?? []).map((v) => String(v)).filter((v) => v !== "");
    switch (f.field) {
      case "phase": {
        if (!values.length) break;
        const c = inArray(leadsTable.phase, values);
        conds.push(f.operator === "is_not" ? not(c) : c);
        break;
      }
      case "status": {
        if (!values.length) break;
        const c = inArray(leadsTable.status, values);
        conds.push(f.operator === "is_not" ? not(c) : c);
        break;
      }
      case "source": {
        if (!values.length) break;
        const c = inArray(leadsTable.source, values);
        conds.push(f.operator === "is_not" ? not(c) : c);
        break;
      }
      case "owner": {
        if (!values.length) break;
        if (f.operator === "contains") {
          // Case-insensitive partial match — "Alex" matches "Alex Smith".
          const pattern = `%${values[0]!.replace(/[%_]/g, "\\$&")}%`;
          conds.push(ilike(leadsTable.assignedTo, pattern));
        } else {
          const c = inArray(leadsTable.assignedTo, values);
          conds.push(f.operator === "is_not" ? not(c) : c);
        }
        break;
      }
      case "division": {
        const ids = values.map((v) => Number(v)).filter((n) => Number.isInteger(n));
        if (!ids.length) break;
        const c = inArray(leadsTable.divisionId, ids);
        conds.push(f.operator === "is_not" ? not(c) : c);
        break;
      }
      case "created": {
        const d = dateFrom(values[0], f.operator === "on_or_before");
        if (!d) return { error: "Created-date filters need a YYYY-MM-DD value" };
        conds.push(
          f.operator === "on_or_before"
            ? lte(leadsTable.createdAt, d)
            : gte(leadsTable.createdAt, d),
        );
        break;
      }
      case "vehicleInterest": {
        const term = values[0]?.trim();
        if (!term) break;
        const pattern = `%${term.replace(/[%_]/g, "\\$&")}%`;
        const interestMatch = sql<boolean>`exists (
          select 1 from lead_vehicle_interests lvi
          where lvi.lead_id = ${leadsTable.id}
            and lvi.dealer_id = ${leadsTable.dealerId}
            and (lvi.make || ' ' || lvi.model || ' ' || coalesce(lvi.variant, '')) ilike ${pattern}
        )`;
        const textMatch = or(
          ilike(leadsTable.selectedModel, pattern),
          ilike(leadsTable.interestedModelText, pattern),
        )!;
        conds.push(or(interestMatch, textMatch)!);
        break;
      }
      default:
        return { error: `Unsupported filter field: ${f.field}` };
    }
  }
  return conds;
}

async function leadsMatchingFilters(
  dealerId: number,
  filters: LeadFilter[],
): Promise<Lead[] | { error: string }> {
  const conds = filterConditions(filters);
  if ("error" in conds) return conds;
  return db
    .select()
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.dealerId, dealerId),
        isNull(leadsTable.deletedAt),
        ...(conds as SQL[]),
      ),
    )
    .orderBy(desc(leadsTable.createdAt));
}

// --- recipient eligibility ----------------------------------------------------

type Channel = "email" | "whatsapp";
type Classified = {
  included: Array<{ lead: Lead; channels: Channel[] }>;
  excluded: Array<{ leadId: number; name: string; reason: string }>;
};

async function classifyRecipients(
  dealerId: number,
  leads: Lead[],
  channels: Channel[],
  formId: number | null,
): Promise<Classified> {
  const included: Classified["included"] = [];
  const excluded: Classified["excluded"] = [];
  const alreadySent = new Set<number>();
  if (formId != null && leads.length) {
    const rows = await db
      .select({ leadId: feedbackInvitationsTable.leadId })
      .from(feedbackInvitationsTable)
      .where(
        and(
          eq(feedbackInvitationsTable.dealerId, dealerId),
          eq(feedbackInvitationsTable.formId, formId),
          inArray(
            feedbackInvitationsTable.leadId,
            leads.map((l) => l.id),
          ),
        ),
      );
    for (const r of rows) alreadySent.add(r.leadId);
  }
  for (const lead of leads) {
    if (alreadySent.has(lead.id)) {
      excluded.push({ leadId: lead.id, name: lead.name, reason: "already_sent" });
      continue;
    }
    const available: Channel[] = [];
    let emailBlocked = false;
    let waBlocked = false;
    if (channels.includes("email") && lead.email) {
      if (lead.emailOptOut) emailBlocked = true;
      else available.push("email");
    }
    if (channels.includes("whatsapp") && lead.phone) {
      if (await isWhatsappOptedOut(dealerId, lead.phone)) waBlocked = true;
      else available.push("whatsapp");
    }
    if (!available.length) {
      excluded.push({
        leadId: lead.id,
        name: lead.name,
        reason: emailBlocked
          ? "email_opt_out"
          : waBlocked
            ? "whatsapp_opt_out"
            : "no_contact",
      });
      continue;
    }
    included.push({ lead, channels: available });
  }
  return { included, excluded };
}

// --- form administration --------------------------------------------------------

router.get("/feedback-forms", async (_req, res): Promise<void> => {
  if (!requireGM(res)) return;
  const dealerId = activeDealerId(res);
  const forms = await db
    .select()
    .from(feedbackFormsTable)
    .where(eq(feedbackFormsTable.dealerId, dealerId))
    .orderBy(desc(feedbackFormsTable.updatedAt));
  const counts = await formCounts(dealerId, forms.map((f) => f.id));
  res.json(
    forms.map((f) =>
      serializeForm(f, counts.get(f.id) ?? { sent: 0, responded: 0 }),
    ),
  );
});

router.post("/feedback-forms", async (req, res): Promise<void> => {
  if (!requireGM(res)) return;
  const dealerId = activeDealerId(res);
  const body = CreateFeedbackFormBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const questions = normalizeQuestions(body.data.questions as FeedbackQuestion[]);
  const invalid = validateQuestions(questions);
  if (invalid) {
    res.status(422).json({ error: invalid });
    return;
  }
  const [form] = await db
    .insert(feedbackFormsTable)
    .values({
      dealerId,
      name: body.data.name.trim(),
      description: body.data.description?.trim() || null,
      status: "draft",
      questions,
      createdBy: res.locals.user?.name ?? res.locals.user?.email ?? null,
    })
    .returning();
  res.status(201).json(serializeForm(form!, { sent: 0, responded: 0 }));
});

// Literal sub-path BEFORE /feedback-forms/:id.
router.post(
  "/feedback-forms/preview-recipients",
  async (req, res): Promise<void> => {
    if (!requireGM(res)) return;
    const dealerId = activeDealerId(res);
    const body = PreviewFeedbackRecipientsBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    const channels = (body.data.channels?.length
      ? body.data.channels
      : ["email", "whatsapp"]) as Channel[];
    let leads: Lead[];
    if (body.data.leadIds?.length) {
      leads = await db
        .select()
        .from(leadsTable)
        .where(
          and(
            eq(leadsTable.dealerId, dealerId),
            isNull(leadsTable.deletedAt),
            inArray(leadsTable.id, body.data.leadIds),
          ),
        );
    } else {
      const result = await leadsMatchingFilters(
        dealerId,
        (body.data.filters ?? []) as LeadFilter[],
      );
      if ("error" in result) {
        res.status(422).json({ error: result.error });
        return;
      }
      leads = result;
    }
    const { included, excluded } = await classifyRecipients(
      dealerId,
      leads,
      channels,
      body.data.formId ?? null,
    );
    res.json({
      matchingCount: leads.length,
      matchingLeadIds: leads.map((l) => l.id),
      included: included.slice(0, 200).map(({ lead, channels: ch }) => ({
        leadId: lead.id,
        name: lead.name,
        email: lead.email ?? null,
        phone: lead.phone ?? null,
        channels: ch,
      })),
      excluded: excluded.slice(0, 200),
    });
  },
);

router.get("/feedback-forms/:id", async (req, res): Promise<void> => {
  if (!requireGM(res)) return;
  const params = GetFeedbackFormParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid form id" });
    return;
  }
  const dealerId = activeDealerId(res);
  const form = await getForm(dealerId, params.data.id);
  if (!form) {
    res.status(404).json({ error: "Form not found" });
    return;
  }
  const counts = await formCounts(dealerId, [form.id]);
  res.json(serializeForm(form, counts.get(form.id) ?? { sent: 0, responded: 0 }));
});

router.patch("/feedback-forms/:id", async (req, res): Promise<void> => {
  if (!requireGM(res)) return;
  const params = UpdateFeedbackFormParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid form id" });
    return;
  }
  const body = UpdateFeedbackFormBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const dealerId = activeDealerId(res);
  const form = await getForm(dealerId, params.data.id);
  if (!form) {
    res.status(404).json({ error: "Form not found" });
    return;
  }
  if (form.status === "archived") {
    res.status(409).json({ error: "Reactivate the form before editing it" });
    return;
  }
  const patch: Partial<typeof feedbackFormsTable.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (body.data.name !== undefined) patch.name = body.data.name.trim();
  if (body.data.description !== undefined)
    patch.description = body.data.description?.trim() || null;
  if (body.data.questions !== undefined) {
    const questions = normalizeQuestions(
      body.data.questions as FeedbackQuestion[],
    );
    const invalid = validateQuestions(questions);
    if (invalid) {
      res.status(422).json({ error: invalid });
      return;
    }
    if (form.status === "published" && questions.length === 0) {
      res.status(422).json({ error: "A published form needs at least one question" });
      return;
    }
    patch.questions = questions;
  }
  const [updated] = await db
    .update(feedbackFormsTable)
    .set(patch)
    .where(
      and(
        eq(feedbackFormsTable.id, form.id),
        eq(feedbackFormsTable.dealerId, dealerId),
      ),
    )
    .returning();
  const counts = await formCounts(dealerId, [form.id]);
  res.json(
    serializeForm(updated!, counts.get(form.id) ?? { sent: 0, responded: 0 }),
  );
});

router.post("/feedback-forms/:id/status", async (req, res): Promise<void> => {
  if (!requireGM(res)) return;
  const params = SetFeedbackFormStatusParams.safeParse(req.params);
  const body = SetFeedbackFormStatusBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const dealerId = activeDealerId(res);
  const form = await getForm(dealerId, params.data.id);
  if (!form) {
    res.status(404).json({ error: "Form not found" });
    return;
  }
  const action = body.data.action;
  let next: string;
  if (action === "publish") {
    if (form.status !== "draft") {
      res.status(409).json({ error: "Only drafts can be published" });
      return;
    }
    if (!((form.questions ?? []) as FeedbackQuestion[]).length) {
      res.status(422).json({ error: "Add at least one question before publishing" });
      return;
    }
    next = "published";
  } else if (action === "archive") {
    next = "archived";
  } else {
    // reactivate: archived → published (drafts stay drafts)
    if (form.status !== "archived") {
      res.status(409).json({ error: "Only archived forms can be reactivated" });
      return;
    }
    next = ((form.questions ?? []) as FeedbackQuestion[]).length
      ? "published"
      : "draft";
  }
  const [updated] = await db
    .update(feedbackFormsTable)
    .set({ status: next, updatedAt: new Date() })
    .where(
      and(
        eq(feedbackFormsTable.id, form.id),
        eq(feedbackFormsTable.dealerId, dealerId),
      ),
    )
    .returning();
  const counts = await formCounts(dealerId, [form.id]);
  res.json(
    serializeForm(updated!, counts.get(form.id) ?? { sent: 0, responded: 0 }),
  );
});

router.post("/feedback-forms/:id/duplicate", async (req, res): Promise<void> => {
  if (!requireGM(res)) return;
  const params = DuplicateFeedbackFormParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid form id" });
    return;
  }
  const dealerId = activeDealerId(res);
  const form = await getForm(dealerId, params.data.id);
  if (!form) {
    res.status(404).json({ error: "Form not found" });
    return;
  }
  const [copy] = await db
    .insert(feedbackFormsTable)
    .values({
      dealerId,
      name: `${form.name} (copy)`,
      description: form.description,
      status: "draft",
      questions: form.questions,
      createdBy: res.locals.user?.name ?? res.locals.user?.email ?? null,
    })
    .returning();
  res.status(201).json(serializeForm(copy!, { sent: 0, responded: 0 }));
});

// --- bulk send -----------------------------------------------------------------

const DEFAULT_EXPIRY_DAYS = 14;

router.post("/feedback-forms/:id/send", async (req, res): Promise<void> => {
  if (!requireGM(res)) return;
  const params = SendFeedbackFormParams.safeParse(req.params);
  const body = SendFeedbackFormBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const dealerId = activeDealerId(res);
  const form = await getForm(dealerId, params.data.id);
  if (!form) {
    res.status(404).json({ error: "Form not found" });
    return;
  }
  if (form.status !== "published") {
    res.status(409).json({ error: "Only published forms can be sent" });
    return;
  }
  const channels = body.data.channels as Channel[];
  let leads: Lead[];
  if (body.data.mode === "selected") {
    const ids = body.data.leadIds ?? [];
    if (!ids.length) {
      res.status(422).json({ error: "Select at least one lead" });
      return;
    }
    leads = await db
      .select()
      .from(leadsTable)
      .where(
        and(
          eq(leadsTable.dealerId, dealerId),
          isNull(leadsTable.deletedAt),
          inArray(leadsTable.id, ids),
        ),
      );
  } else {
    const result = await leadsMatchingFilters(
      dealerId,
      (body.data.filters ?? []) as LeadFilter[],
    );
    if ("error" in result) {
      res.status(422).json({ error: result.error });
      return;
    }
    leads = result;
  }
  const { included, excluded } = await classifyRecipients(
    dealerId,
    leads,
    channels,
    form.id,
  );

  const expiresAt = new Date(
    Date.now() +
      (body.data.expiresInDays ?? DEFAULT_EXPIRY_DAYS) * 24 * 60 * 60 * 1000,
  );
  const snapshot = (form.questions ?? []) as FeedbackQuestion[];
  const actor = res.locals.user?.name ?? res.locals.user?.email ?? "General Manager";
  let queued = 0;

  for (const { lead, channels: available } of included) {
    // Atomic duplicate-send guard: unique (dealer, form, lead) index.
    const [inv] = await db
      .insert(feedbackInvitationsTable)
      .values({
        dealerId,
        formId: form.id,
        leadId: lead.id,
        formName: form.name,
        questionsSnapshot: snapshot,
        expiresAt,
        status: "sent",
        channels: available,
        createdBy: actor,
      })
      .onConflictDoNothing({
        target: [
          feedbackInvitationsTable.dealerId,
          feedbackInvitationsTable.formId,
          feedbackInvitationsTable.leadId,
        ],
      })
      .returning();
    if (!inv) {
      excluded.push({ leadId: lead.id, name: lead.name, reason: "already_sent" });
      continue;
    }
    const link = feedbackFormUrl(inv.token);
    let emailLogId: number | null = null;
    let whatsappLogId: number | null = null;
    if (available.includes("email") && lead.email && link) {
      const log = await enqueueEmail({
        template: "feedback.survey",
        to: lead.email,
        dealerId,
        leadId: lead.id,
        customerId: lead.customerId,
        data: {
          name: lead.name.split(" ")[0] ?? lead.name,
          context: "being with us",
          link,
        },
        dedupeKey: `feedback:inv:${inv.id}:email`,
      });
      emailLogId = log?.id ?? null;
    }
    if (available.includes("whatsapp") && lead.phone && link) {
      const log = await enqueueWhatsapp({
        kind: "feedback.survey",
        to: lead.phone,
        body: `Hi ${lead.name.split(" ")[0] ?? lead.name} — thank you for being with us. We'd love two minutes of your feedback: ${link}`,
        dealerId,
        leadId: lead.id,
        customerId: lead.customerId,
        summary: `Feedback form: ${form.name}`,
        actor,
        dedupeKey: `feedback:inv:${inv.id}:whatsapp`,
      });
      whatsappLogId = log?.id ?? null;
    }
    await db
      .update(feedbackInvitationsTable)
      .set({ emailLogId, whatsappLogId })
      .where(eq(feedbackInvitationsTable.id, inv.id));
    await db.insert(timelineEventsTable).values({
      dealerId,
      customerId: lead.customerId,
      domain: "leads",
      kind: "feedback_sent",
      title: `Feedback form sent — ${form.name}`,
      detail: `Via ${available.join(" + ")}`,
      actor,
      isAgent: false,
      refType: "lead",
      refId: lead.id,
    });
    queued++;
  }

  res.json({ queued, skipped: excluded });
});

router.get(
  "/feedback-forms/:id/invitations",
  async (req, res): Promise<void> => {
    if (!requireGM(res)) return;
    const params = ListFeedbackFormInvitationsParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid form id" });
      return;
    }
    const dealerId = activeDealerId(res);
    const form = await getForm(dealerId, params.data.id);
    if (!form) {
      res.status(404).json({ error: "Form not found" });
      return;
    }
    const rows = await db
      .select({ invitation: feedbackInvitationsTable, leadName: leadsTable.name })
      .from(feedbackInvitationsTable)
      .leftJoin(leadsTable, eq(leadsTable.id, feedbackInvitationsTable.leadId))
      .where(
        and(
          eq(feedbackInvitationsTable.dealerId, dealerId),
          eq(feedbackInvitationsTable.formId, form.id),
        ),
      )
      .orderBy(desc(feedbackInvitationsTable.createdAt));
    res.json(
      await serializeInvitations(
        rows.map((r) => ({ ...r.invitation, leadName: r.leadName })),
      ),
    );
  },
);

// --- lead history (leads-module RBAC via /leads path segment) -------------------

router.get("/leads/:id/feedback", async (req, res): Promise<void> => {
  const params = GetLeadFeedbackParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid lead id" });
    return;
  }
  const dealerId = activeDealerId(res);
  const [lead] = await db
    .select({ id: leadsTable.id, name: leadsTable.name })
    .from(leadsTable)
    .where(
      and(eq(leadsTable.id, params.data.id), eq(leadsTable.dealerId, dealerId)),
    );
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }
  const invitations = await db
    .select()
    .from(feedbackInvitationsTable)
    .where(
      and(
        eq(feedbackInvitationsTable.dealerId, dealerId),
        eq(feedbackInvitationsTable.leadId, lead.id),
      ),
    )
    .orderBy(desc(feedbackInvitationsTable.createdAt));
  res.json(
    await serializeInvitations(
      invitations.map((i) => ({ ...i, leadName: lead.name })),
    ),
  );
});

export default router;
