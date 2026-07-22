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
import {
  handleTestDriveIntent,
  type TestDriveIntentExtraction,
} from "./test-drive-intent";

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
  if (!lead) {
    // Call isn't linked to a (live) lead — nothing to score a sentiment
    // against and no booking possible, but the intent screen still runs so
    // a stated test-drive wish leaves a trace on the call itself.
    if (call.transcript) {
      try {
        const extraction = await extractTestDriveIntentOnly(call.transcript);
        await handleTestDriveIntent(call, null, extraction);
      } catch (err) {
        logger.error(
          { err, callLogId },
          "Test-drive intent extraction failed for unlinked call",
        );
      }
    }
    return;
  }

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

  const nowGuyana = new Date().toLocaleString("en-US", {
    timeZone: "America/Guyana",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const facts = [
    `Now (Guyana time, GMT-4): ${nowGuyana}`,
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
    call.transcript
      ? `Call transcript (both parties):\n${call.transcript.slice(0, 6000)}`
      : null,
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
      max_tokens: 400,
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

Also screen the transcript for TEST-DRIVE INTENT: did the customer ask for or agree to a test drive on this call? If they stated an explicit date AND time, convert it to Guyana local time (GMT-4) using the "Now" fact above for relative dates ("Saturday at 10am"). NEVER invent or guess a time — if the customer was vague ("sometime next week", "I'll call back"), testDriveTime must be null.

Respond with ONLY a JSON object:
{"sentiment": "positive"|"neutral"|"negative", "confidence": number (0 to 1 — how sure you are about the sentiment call), "summary": "1-2 sentence summary of the call and suggested next step", "testDriveIntent": boolean, "testDriveTime": "YYYY-MM-DDTHH:mm" or null (Guyana local time, only when explicitly stated), "testDriveTimeConfidence": number (0 to 1 — how sure you are the extracted time is what the customer meant; 0 when no time), "testDriveVehicle": "vehicle the customer mentioned" or null}`,
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
      testDriveIntent?: boolean;
      testDriveTime?: string | null;
      testDriveTimeConfidence?: number | null;
      testDriveVehicle?: string | null;
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

    // Test-drive intent rides the same model pass. Only transcripts carry the
    // customer's own words, so intent handling is transcript-gated; it runs
    // regardless of the sentiment confidence gate below (its own guardrails
    // and idempotency live in test-drive-intent.ts).
    const intentExtraction: TestDriveIntentExtraction = {
      intent: parsed.testDriveIntent === true,
      timeText:
        typeof parsed.testDriveTime === "string" ? parsed.testDriveTime : null,
      timeConfidence:
        typeof parsed.testDriveTimeConfidence === "number" &&
        parsed.testDriveTimeConfidence >= 0 &&
        parsed.testDriveTimeConfidence <= 1
          ? parsed.testDriveTimeConfidence
          : null,
      vehicleMention:
        typeof parsed.testDriveVehicle === "string"
          ? parsed.testDriveVehicle.slice(0, 120)
          : null,
    };
    const runIntent = () =>
      call.transcript
        ? handleTestDriveIntent(call, lead, intentExtraction)
        : Promise.resolve();

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
      await runIntent();
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

    await runIntent();
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

/**
 * Intent-only extraction for calls with no live lead — the sentiment pass is
 * skipped (nothing to score against), but a stated test-drive wish should
 * still leave a trace on the call. Same rules as the combined pass: convert
 * explicit times to Guyana local, NEVER invent a time.
 */
async function extractTestDriveIntentOnly(
  transcript: string,
): Promise<TestDriveIntentExtraction> {
  const nowGuyana = new Date().toLocaleString("en-US", {
    timeZone: "America/Guyana",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 250,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `You are a car-dealership sales assistant. Screen the call transcript below for TEST-DRIVE INTENT: did the customer ask for or agree to a test drive on this call? If they stated an explicit date AND time, convert it to Guyana local time (GMT-4) — "Now (Guyana time, GMT-4): ${nowGuyana}" — for relative dates ("Saturday at 10am"). NEVER invent or guess a time — if the customer was vague ("sometime next week", "I'll call back"), testDriveTime must be null.

${guardUntrusted("call_transcript", transcript.slice(0, 6000))}

Respond with ONLY a JSON object:
{"testDriveIntent": boolean, "testDriveTime": "YYYY-MM-DDTHH:mm" or null (Guyana local time, only when explicitly stated), "testDriveTimeConfidence": number (0 to 1; 0 when no time), "testDriveVehicle": "vehicle the customer mentioned" or null}`,
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
    testDriveIntent?: boolean;
    testDriveTime?: string | null;
    testDriveTimeConfidence?: number | null;
    testDriveVehicle?: string | null;
  };
  return {
    intent: parsed.testDriveIntent === true,
    timeText:
      typeof parsed.testDriveTime === "string" ? parsed.testDriveTime : null,
    timeConfidence:
      typeof parsed.testDriveTimeConfidence === "number" &&
      parsed.testDriveTimeConfidence >= 0 &&
      parsed.testDriveTimeConfidence <= 1
        ? parsed.testDriveTimeConfidence
        : null,
    vehicleMention:
      typeof parsed.testDriveVehicle === "string"
        ? parsed.testDriveVehicle.slice(0, 120)
        : null,
  };
}

/** Fire-and-forget: score a finished call and note the summary on the lead. */
export function autoAnalyzeCall(callLogId: number): void {
  void analyze(callLogId).catch((err) => {
    logger.error({ err, callLogId }, "Auto call analysis crashed");
  });
}
