import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { db, leadsTable, vehiclesTable } from "@workspace/db";
import {
  GetPipelineSuggestionsQueryParams,
  GetPipelineSuggestionsResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

const PHASE_LABEL: Record<string, string> = {
  aware: "New Lead",
  consider: "Working",
  engage: "Appointment",
  negotiate: "Desking",
  won: "Delivered",
  lost: "Lost",
};

const STAGE_GOAL: Record<string, string> = {
  aware: "make first contact and qualify interest",
  consider: "nurture the lead and match inventory",
  engage: "book and confirm a test drive or showroom visit",
  negotiate: "structure terms and close the deal",
  won: "deliver flawlessly and set up retention",
  lost: "review the loss and plan re-engagement",
};

router.get("/pipeline/suggestions", async (req, res): Promise<void> => {
  const query = GetPipelineSuggestionsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const { phase } = query.data;
  const label = PHASE_LABEL[phase] ?? phase;

  const [leads, vehicles] = await Promise.all([
    db.select().from(leadsTable).where(eq(leadsTable.phase, phase)),
    db.select().from(vehiclesTable),
  ]);

  const vehicleName = (id: number | null | undefined) => {
    if (!id) return null;
    const v = vehicles.find((x) => x.id === id);
    return v ? `${v.year} ${v.make} ${v.model}` : null;
  };

  const leadLines = leads
    .slice(0, 25)
    .map((l) => {
      const car = vehicleName(l.interestedVehicleId);
      return `- ${l.name} (AI score ${l.aiScore}, via ${l.channel}${
        l.assignedTo ? `, handled by ${l.assignedTo}` : ", unassigned"
      }${car ? `, interested in ${car}` : ""})`;
    })
    .join("\n");

  const prompt = [
    `You are AURA, the AI concierge running an ultra-premium automotive dealership.`,
    `You are looking at the "${label}" stage of the sales pipeline, where the goal is to ${STAGE_GOAL[phase] ?? "advance the relationship"}.`,
    `There are ${leads.length} leads currently in this stage:`,
    leadLines || "- (no leads currently in this stage)",
    ``,
    `Recommend the most valuable next actions a dealership manager should take right now for this stage.`,
    `Return ONLY a JSON object (no markdown, no commentary) with exactly these keys:`,
    `{`,
    `  "headline": string,   // one confident sentence summarising the state of this stage`,
    `  "actions": [          // 2 to 4 concrete next actions, most important first`,
    `    {`,
    `      "title": string,      // a short imperative action, max 8 words`,
    `      "detail": string,     // one sentence explaining what to do and why`,
    `      "priority": "high" | "medium" | "low",`,
    `      "leadName": string | null  // the specific lead this concerns, or null if it applies to the whole stage`,
    `    }`,
    `  ]`,
    `}`,
    `If there are no leads in this stage, still return a headline and one low-priority action about keeping the stage healthy.`,
    `Reference the real lead names above where relevant. Speak with the polish of a luxury brand: warm, confident, concise, never robotic.`,
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
      req.log.error({ raw }, "Pipeline suggestions returned no JSON object");
      res.status(502).json({ error: "The concierge could not read the stage" });
      return;
    }

    let candidate: { headline?: unknown; actions?: unknown };
    try {
      candidate = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
    } catch {
      req.log.error({ raw }, "Pipeline suggestions returned invalid JSON");
      res.status(502).json({ error: "The concierge could not read the stage" });
      return;
    }

    const result = GetPipelineSuggestionsResponse.safeParse({
      phase,
      label,
      count: leads.length,
      headline: candidate.headline,
      actions: candidate.actions,
    });
    if (!result.success) {
      req.log.error(
        { issues: result.error.issues },
        "Pipeline suggestions failed validation",
      );
      res.status(502).json({ error: "The concierge returned an unexpected shape" });
      return;
    }

    res.json(GetPipelineSuggestionsResponse.parse(result.data));
  } catch (err) {
    req.log.error({ err }, "Pipeline suggestions request failed");
    res.status(502).json({ error: "The concierge is unavailable right now" });
  }
});

export default router;
