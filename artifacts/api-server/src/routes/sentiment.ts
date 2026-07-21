import { Router, type IRouter } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { db, leadsTable, timelineEventsTable } from "@workspace/db";
import { activeDealerId } from "../middlewares/rbac";
import {
  GetSentimentAnalysisQueryParams,
  GetSentimentAnalysisResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

type SentimentPayload = ReturnType<typeof GetSentimentAnalysisResponse.parse>;

const CACHE_TTL_MS = 10 * 60 * 1000;
// Cache is per-dealer — the corpus differs by active dealership.
const cache = new Map<number, { data: SentimentPayload; at: number }>();

const MAX_ITEMS = 40;

router.get("/dashboard/sentiment", async (req, res): Promise<void> => {
  const query = GetSentimentAnalysisQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  // zod coerce.boolean would turn "false" into true — only the literal
  // string "true" should bust the cache.
  const refresh = req.query.refresh === "true";
  const dealerId = activeDealerId(res);

  const cached = cache.get(dealerId);
  if (!refresh && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    res.json(cached.data);
    return;
  }

  const [recentLeads, noteEvents] = await Promise.all([
    db
      .select()
      .from(leadsTable)
      .where(eq(leadsTable.dealerId, dealerId))
      .orderBy(desc(leadsTable.createdAt))
      .limit(120),
    db
      .select()
      .from(timelineEventsTable)
      .where(
        and(
          eq(timelineEventsTable.dealerId, dealerId),
          eq(timelineEventsTable.domain, "leads"),
        ),
      )
      .orderBy(desc(timelineEventsTable.createdAt))
      .limit(200),
  ]);

  const leadName = new Map(recentLeads.map((l) => [l.id, l.name]));
  const missingIds = [
    ...new Set(
      noteEvents
        .filter(
          (e) =>
            e.refType === "lead" &&
            e.refId != null &&
            !leadName.has(e.refId),
        )
        .map((e) => e.refId as number),
    ),
  ];
  if (missingIds.length > 0) {
    const extra = await db
      .select({ id: leadsTable.id, name: leadsTable.name })
      .from(leadsTable)
      .where(
        and(
          eq(leadsTable.dealerId, dealerId),
          inArray(leadsTable.id, missingIds),
        ),
      );
    for (const l of extra) leadName.set(l.id, l.name);
  }

  type Item = { leadId: number | null; leadName: string; text: string };
  const items: Item[] = [];

  for (const e of noteEvents) {
    if (items.length >= MAX_ITEMS) break;
    if (!e.detail || e.detail.trim().length < 10) continue;
    if (!["note", "whatsapp_message", "call"].includes(e.kind)) continue;
    const id = e.refType === "lead" ? (e.refId ?? null) : null;
    items.push({
      leadId: id,
      leadName: (id != null ? leadName.get(id) : null) ?? "Unknown lead",
      text: e.detail.trim().slice(0, 400),
    });
  }

  for (const l of recentLeads) {
    if (items.length >= MAX_ITEMS) break;
    const bits = [l.notes, l.closureReason, l.keyInterestDriver]
      .filter((t): t is string => !!t && t.trim().length >= 10)
      .map((t) => t.trim().slice(0, 400));
    for (const text of bits) {
      if (items.length >= MAX_ITEMS) break;
      items.push({ leadId: l.id, leadName: l.name, text });
    }
  }

  if (items.length === 0) {
    const empty = GetSentimentAnalysisResponse.parse({
      overallScore: 50,
      overallLabel: "neutral",
      summary:
        "Not enough customer conversation data yet — sentiment will appear as notes and messages accumulate.",
      distribution: { positive: 0, neutral: 100, negative: 0 },
      themes: [],
      highlights: [],
      sampleSize: 0,
      generatedAt: new Date().toISOString(),
    });
    cache.set(dealerId, { data: empty, at: Date.now() });
    res.json(empty);
    return;
  }

  const corpus = items
    .map(
      (it, i) =>
        `${i + 1}. [lead ${it.leadId ?? "unknown"} — ${it.leadName}] ${it.text}`,
    )
    .join("\n");

  const prompt = [
    `You are AURA, the AI concierge of an ultra-premium automotive dealership.`,
    `Below are ${items.length} recent customer-facing notes and messages from the lead pipeline:`,
    corpus,
    ``,
    `Analyse the overall customer sentiment across these interactions.`,
    `Return ONLY a JSON object (no markdown, no commentary) with exactly these keys:`,
    `{`,
    `  "overallScore": number,   // 0 (very negative) to 100 (very positive)`,
    `  "overallLabel": "positive" | "neutral" | "negative",`,
    `  "summary": string,        // two confident sentences on the customer mood and what drives it`,
    `  "distribution": { "positive": number, "neutral": number, "negative": number },  // percentages, must sum to 100`,
    `  "themes": [ { "theme": string, "sentiment": "positive" | "neutral" | "negative", "mentions": number } ],  // 3 to 5 recurring topics`,
    `  "highlights": [ { "leadId": number | null, "leadName": string, "sentiment": "positive" | "neutral" | "negative", "snippet": string } ]  // 3 to 4 representative quotes, snippet max 20 words, leadId from the brackets above or null`,
    `}`,
    `Use the real lead names and ids provided. Be precise and honest — do not inflate positivity.`,
  ].join("\n");

  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1400,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    });

    const textBlock = message.content.find((b) => b.type === "text");
    const raw = textBlock && textBlock.type === "text" ? textBlock.text : "";
    const jsonStart = raw.indexOf("{");
    const jsonEnd = raw.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd === -1) {
      req.log.error({ raw }, "Sentiment analysis returned no JSON object");
      res.status(502).json({ error: "The sentiment engine could not read the room" });
      return;
    }

    let candidate: Record<string, unknown>;
    try {
      candidate = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
    } catch {
      req.log.error({ raw }, "Sentiment analysis returned invalid JSON");
      res.status(502).json({ error: "The sentiment engine could not read the room" });
      return;
    }

    const result = GetSentimentAnalysisResponse.safeParse({
      ...candidate,
      sampleSize: items.length,
      generatedAt: new Date().toISOString(),
    });
    if (!result.success) {
      req.log.error(
        { issues: result.error.issues },
        "Sentiment analysis failed validation",
      );
      res.status(502).json({ error: "The sentiment engine returned an unexpected shape" });
      return;
    }

    cache.set(dealerId, { data: result.data, at: Date.now() });
    res.json(result.data);
  } catch (err) {
    req.log.error({ err }, "Sentiment analysis request failed");
    res.status(502).json({ error: "The sentiment engine is unavailable right now" });
  }
});

export default router;
