import { Router, type IRouter } from "express";
import { and, eq, isNull } from "drizzle-orm";
import {
  db,
  feedbackInvitationsTable,
  leadsTable,
  dealersTable,
  timelineEventsTable,
  type FeedbackInvitation,
  type FeedbackQuestion,
} from "@workspace/db";
import {
  GetPublicFeedbackFormParams,
  SubmitPublicFeedbackFormParams,
  SubmitPublicFeedbackFormBody,
} from "@workspace/api-zod";

// ---------------------------------------------------------------------------
// PUBLIC customer feedback form — reached from the unique tokenized link sent
// to a lead. Mounted BEFORE requireAuth with a scoped public rate limit.
// ---------------------------------------------------------------------------

const router: IRouter = Router();

async function findInvitation(token: string): Promise<FeedbackInvitation | null> {
  if (!token || token.length > 128) return null;
  const [inv] = await db
    .select()
    .from(feedbackInvitationsTable)
    .where(eq(feedbackInvitationsTable.token, token));
  return inv ?? null;
}

async function brandNameFor(dealerId: number): Promise<string> {
  const [dealer] = await db
    .select({ name: dealersTable.name })
    .from(dealersTable)
    .where(eq(dealersTable.id, dealerId));
  return dealer?.name ?? "AURA Dealership";
}

async function serializePublic(inv: FeedbackInvitation) {
  const [lead] = await db
    .select({ name: leadsTable.name })
    .from(leadsTable)
    .where(
      and(eq(leadsTable.id, inv.leadId), isNull(leadsTable.deletedAt)),
    );
  return {
    state: inv.submittedAt ? "submitted" : "open",
    formName: inv.formName,
    brandName: await brandNameFor(inv.dealerId),
    leadName: lead?.name ?? null,
    questions: (inv.questionsSnapshot ?? []) as FeedbackQuestion[],
    submittedAt: inv.submittedAt ? inv.submittedAt.toISOString() : null,
  };
}

const INVALID = { error: "This feedback link is not valid" };
const EXPIRED = {
  error: "This feedback link has expired — thank you all the same!",
};

router.get("/feedback/:token", async (req, res): Promise<void> => {
  const params = GetPublicFeedbackFormParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json(INVALID);
    return;
  }
  const inv = await findInvitation(params.data.token);
  if (!inv) {
    res.status(404).json(INVALID);
    return;
  }
  if (!inv.submittedAt && inv.expiresAt.getTime() < Date.now()) {
    res.status(410).json(EXPIRED);
    return;
  }
  res.json(await serializePublic(inv));
});

type Answer = { questionId: string; text?: string; choices?: string[]; rating?: number };

function validateAnswers(
  questions: FeedbackQuestion[],
  answers: Answer[],
): { error: string } | { values: Record<string, unknown> } {
  const byId = new Map(answers.map((a) => [a.questionId, a]));
  const values: Record<string, unknown> = {};
  for (const q of questions) {
    const a = byId.get(q.id);
    switch (q.type) {
      case "text":
      case "long_text": {
        const text = a?.text?.trim() ?? "";
        if (!text && q.required) return { error: `"${q.label}" is required` };
        if (text.length > 4000)
          return { error: `"${q.label}" answer is too long` };
        if (text) values[q.id] = text;
        break;
      }
      case "single_choice": {
        const choices = a?.choices ?? [];
        if (!choices.length) {
          if (q.required) return { error: `"${q.label}" is required` };
          break;
        }
        if (choices.length !== 1)
          return { error: `"${q.label}" accepts a single choice` };
        if (!(q.options ?? []).includes(choices[0]!))
          return { error: `"${q.label}" has an invalid choice` };
        values[q.id] = choices[0];
        break;
      }
      case "multi_choice": {
        const choices = [...new Set(a?.choices ?? [])];
        if (!choices.length) {
          if (q.required) return { error: `"${q.label}" is required` };
          break;
        }
        if (choices.some((c) => !(q.options ?? []).includes(c)))
          return { error: `"${q.label}" has an invalid choice` };
        values[q.id] = choices;
        break;
      }
      case "star_rating": {
        const rating = a?.rating;
        if (rating == null) {
          if (q.required) return { error: `"${q.label}" is required` };
          break;
        }
        const max = q.maxStars ?? 5;
        if (!Number.isInteger(rating) || rating < 1 || rating > max)
          return { error: `"${q.label}" rating must be between 1 and ${max}` };
        values[q.id] = rating;
        break;
      }
    }
  }
  return { values };
}

router.post("/feedback/:token/submit", async (req, res): Promise<void> => {
  const params = SubmitPublicFeedbackFormParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json(INVALID);
    return;
  }
  const body = SubmitPublicFeedbackFormBody.safeParse(req.body);
  if (!body.success) {
    res.status(422).json({ error: "Invalid submission" });
    return;
  }
  const inv = await findInvitation(params.data.token);
  if (!inv) {
    res.status(404).json(INVALID);
    return;
  }
  if (inv.submittedAt) {
    res.status(409).json({ error: "This form was already submitted — thank you!" });
    return;
  }
  if (inv.expiresAt.getTime() < Date.now()) {
    res.status(410).json(EXPIRED);
    return;
  }
  const questions = (inv.questionsSnapshot ?? []) as FeedbackQuestion[];
  const result = validateAnswers(questions, body.data.answers as Answer[]);
  if ("error" in result) {
    res.status(422).json({ error: result.error });
    return;
  }
  // Single-submission guard: compare-and-set on submitted_at IS NULL so two
  // concurrent submits can never both win.
  const [updated] = await db
    .update(feedbackInvitationsTable)
    .set({
      answers: result.values,
      submittedAt: new Date(),
      status: "completed",
    })
    .where(
      and(
        eq(feedbackInvitationsTable.id, inv.id),
        isNull(feedbackInvitationsTable.submittedAt),
      ),
    )
    .returning();
  if (!updated) {
    res.status(409).json({ error: "This form was already submitted — thank you!" });
    return;
  }
  const [lead] = await db
    .select()
    .from(leadsTable)
    .where(eq(leadsTable.id, inv.leadId));
  if (lead) {
    await db.insert(timelineEventsTable).values({
      dealerId: inv.dealerId,
      customerId: lead.customerId,
      domain: "leads",
      kind: "feedback_received",
      title: `Feedback received — ${inv.formName}`,
      detail: `${Object.keys(result.values).length} answer(s) submitted`,
      actor: lead.name,
      isAgent: false,
      refType: "lead",
      refId: lead.id,
    });
  }
  res.json(await serializePublic(updated));
});

export default router;
