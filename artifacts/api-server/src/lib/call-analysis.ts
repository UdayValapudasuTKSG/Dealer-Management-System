import { and, desc, eq } from "drizzle-orm";
import {
  db,
  callLogsTable,
  leadsTable,
  timelineEventsTable,
  agentsTable,
  activityTable,
} from "@workspace/db";
import { sql } from "drizzle-orm";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import {
  confidenceGateReason,
  guardUntrusted,
  isAgentEnabled,
  recordAgentRun,
} from "./agent-governance";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Call sentiment loop — after a call wraps (browser/Twilio call completes, or
// an advisor logs notes on a call), the Sales agent scores the interaction
// and drops a short summary note onto the lead automatically. Kill-switch
// aware; fire-and-forget; never throws into the request path.
// ---------------------------------------------------------------------------

const AGENT_KEY = "sales";
const AGENT_ACTOR = "AURA Sales Agent";
const VALID = ["positive", "neutral", "negative"] as const;

async function analyze(callLogId: number): Promise<void> {
  const [call] = await db
    .select()
    .from(callLogsTable)
    .where(eq(callLogsTable.id, callLogId));
  if (!call) return;
  if (!(await isAgentEnabled(call.dealerId, AGENT_KEY, { strict: true })))
    return;

  const [lead] = await db
    .select()
    .from(leadsTable)
    .where(
      and(eq(leadsTable.id, call.leadId), eq(leadsTable.dealerId, call.dealerId)),
    );
  if (!lead) return;

  // Recent activity gives the model conversational context.
  const recent = await db
    .select({
      title: timelineEventsTable.title,
      detail: timelineEventsTable.detail,
    })
    .from(timelineEventsTable)
    .where(
      and(
        eq(timelineEventsTable.dealerId, call.dealerId),
        eq(timelineEventsTable.refType, "lead"),
        eq(timelineEventsTable.refId, lead.id),
      ),
    )
    .orderBy(desc(timelineEventsTable.createdAt))
    .limit(5);

  const facts = [
    `Direction: ${call.direction}`,
    `Outcome: ${call.status}`,
    call.durationSeconds != null
      ? `Duration: ${Math.round(call.durationSeconds / 60)} min ${call.durationSeconds % 60}s`
      : null,
    lead.phase ? `Lead phase: ${lead.phase}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const untrusted = [
    call.notes ? `Advisor call notes:\n${call.notes}` : null,
    recent.length > 0
      ? `Recent lead activity:\n${recent
          .map((e) => `- ${e.title}${e.detail ? `: ${e.detail.slice(0, 160)}` : ""}`)
          .join("\n")}`
      : null,
  ]
    .filter(Boolean)
    .join("\n\n");

  const started = Date.now();
  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `You are a car-dealership sales assistant. Score the customer's sentiment for the call described below and write a crisp summary an advisor can act on.

Call facts:
${facts}

${untrusted ? guardUntrusted("call_context", untrusted) : "No notes were captured for this call — judge from the call facts alone and keep the summary factual."}

Respond with ONLY a JSON object:
{"sentiment": "positive"|"neutral"|"negative", "confidence": number (0 to 1 — how sure you are about the sentiment call), "summary": "1-2 sentence summary of the call and suggested next step"}`,
            },
          ],
        },
      ],
    });
    const raw = message.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    const jsonStart = raw.indexOf("{");
    const jsonEnd = raw.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd === -1) throw new Error("No JSON in reply");
    const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1)) as {
      sentiment?: string;
      confidence?: number;
      summary?: string;
    };
    const sentiment = VALID.includes(parsed.sentiment as (typeof VALID)[number])
      ? (parsed.sentiment as (typeof VALID)[number])
      : "neutral";
    const confidence =
      typeof parsed.confidence === "number" &&
      parsed.confidence >= 0 &&
      parsed.confidence <= 1
        ? parsed.confidence
        : null;
    const summary =
      typeof parsed.summary === "string"
        ? parsed.summary.slice(0, 500)
        : "Call reviewed.";

    // Confidence hard gate (R9.2): a below-floor score is never written to
    // the call log or lead timeline — it lands in the governance HITL queue
    // for a human to score the call instead.
    const gateReason = confidenceGateReason(confidence, {
      requireConfidence: true,
    });
    if (gateReason) {
      await recordAgentRun({
        dealerId: lead.dealerId,
        agentKey: AGENT_KEY,
        runType: "call_sentiment_auto",
        inputSource: "calls",
        inputSummary: `Call #${call.id} (${call.direction}, ${call.status})`,
        outputSummary: `Suggested ${sentiment} (not applied): ${summary}`,
        confidence,
        status: "needs_review",
        reviewReason: gateReason,
        refType: "lead",
        refId: lead.id,
        latencyMs: Date.now() - started,
      });
      return;
    }

    await db
      .update(callLogsTable)
      .set({ sentiment })
      .where(eq(callLogsTable.id, call.id));

    await db.insert(timelineEventsTable).values({
      dealerId: lead.dealerId,
      customerId: lead.customerId,
      domain: "leads",
      kind: "call_summary",
      title: `Call summary — sentiment: ${sentiment}`,
      detail: summary,
      actor: AGENT_ACTOR,
      isAgent: true,
      refType: "lead",
      refId: lead.id,
    });

    await db.insert(activityTable).values({
      dealerId: lead.dealerId,
      agentKey: AGENT_KEY,
      actor: AGENT_ACTOR,
      isAi: true,
      action: "Scored call sentiment",
      entity: lead.name,
      detail: `${sentiment} — ${summary.slice(0, 160)}`,
    });
    await db
      .update(agentsTable)
      .set({ tasksToday: sql`${agentsTable.tasksToday} + 1` })
      .where(
        and(
          eq(agentsTable.key, AGENT_KEY),
          eq(agentsTable.dealerId, lead.dealerId),
        ),
      );

    await recordAgentRun({
      dealerId: lead.dealerId,
      agentKey: AGENT_KEY,
      runType: "call_sentiment_auto",
      inputSource: "calls",
      inputSummary: `Call #${call.id} (${call.direction}, ${call.status})`,
      outputSummary: `Scored ${sentiment}: ${summary}`,
      confidence,
      refType: "lead",
      refId: lead.id,
      latencyMs: Date.now() - started,
      mutation: true,
      changeSummary: `Call #${call.id} sentiment ${call.sentiment ?? "unscored"} → ${sentiment}; summary note added to lead timeline`,
      affectedEntities: [
        { type: "call_log", id: call.id },
        { type: "lead", id: lead.id },
      ],
    });
  } catch (err) {
    logger.error({ err, callLogId }, "Auto call sentiment failed");
    await recordAgentRun({
      dealerId: call.dealerId,
      agentKey: AGENT_KEY,
      runType: "call_sentiment_auto",
      inputSource: "calls",
      refType: "lead",
      refId: call.leadId,
      status: "error",
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Fire-and-forget: score a finished call and note the summary on the lead. */
export function autoAnalyzeCall(callLogId: number): void {
  void analyze(callLogId).catch((err) => {
    logger.error({ err, callLogId }, "Auto call analysis crashed");
  });
}
