import { Router } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { db, feedbackAutomationTable, feedbackFormsTable } from "@workspace/db";
import { UpdateFeedbackAutomationBody, GetFeedbackAutomationResponse } from "@workspace/api-zod";
import { activeDealerId } from "../middlewares/rbac";

export const feedbackAutomationRouter = Router();

feedbackAutomationRouter.get("/feedback-forms/automation", async (_req, res) => {
  const rows = await db.select().from(feedbackAutomationTable).where(eq(feedbackAutomationTable.dealerId, activeDealerId(res)));
  res.json(GetFeedbackAutomationResponse.parse({ rules: (["sales", "service"] as const).map(kind => {
    const rule = rows.find(r => r.kind === kind);
    return rule ?? { kind, enabled: false, formId: null, delayDays: 2, channels: ["email"] };
  }) }));
});

feedbackAutomationRouter.put("/feedback-forms/automation", async (req, res) => {
  const parsed = UpdateFeedbackAutomationBody.safeParse(req.body);
  if (!parsed.success || new Set(parsed.data?.rules.map(r => r.kind)).size !== 2) {
    res.status(400).json({ error: "Provide one sales rule and one service rule with a delay from 0 to 365 days." }); return;
  }
  const dealerId = activeDealerId(res);
  const ids = parsed.data.rules.flatMap(r => r.formId == null ? [] : [r.formId]);
  const forms = ids.length ? await db.select().from(feedbackFormsTable).where(and(
    eq(feedbackFormsTable.dealerId, dealerId), inArray(feedbackFormsTable.id, ids),
  )) : [];
  if (parsed.data.rules.some(r => r.enabled && !forms.some(f => f.id === r.formId && f.status === "published"))) {
    res.status(422).json({ error: "Each enabled rule needs a published feedback form from this dealership." }); return;
  }
  if (parsed.data.rules.some(r => r.formId != null && !forms.some(f => f.id === r.formId))) {
    res.status(422).json({ error: "Selected form does not belong to this dealership." }); return;
  }
  await db.transaction(async tx => {
    for (const rule of parsed.data.rules) {
      const [before] = await tx.select().from(feedbackAutomationTable).where(and(
        eq(feedbackAutomationTable.dealerId, dealerId), eq(feedbackAutomationTable.kind, rule.kind),
      )).for("update");
      const now = new Date();
      const values = { ...rule, channels: [...new Set(rule.channels)], updatedAt: now,
        startsAt: rule.enabled && !before?.enabled ? now : before?.startsAt ?? now };
      await tx.insert(feedbackAutomationTable).values({ dealerId, ...values })
        .onConflictDoUpdate({ target: [feedbackAutomationTable.dealerId, feedbackAutomationTable.kind], set: values });
    }
  });
  res.json(GetFeedbackAutomationResponse.parse(parsed.data));
});
