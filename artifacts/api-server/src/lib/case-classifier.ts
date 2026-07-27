import { and, eq } from "drizzle-orm";
import {
  db,
  casesTable,
  timelineEventsTable,
  CASE_TYPES,
  CASE_SEVERITIES,
  type CustomerCase,
  type CaseType,
  type CaseSeverity,
} from "@workspace/db";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import {
  isAgentEnabled,
  recordAgentRun,
  guardUntrusted,
  confidenceGateReason,
} from "./agent-governance";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// A16 Case Classifier — autonomous internal writer (R3): on a newly opened
// service case it classifies type + severity from the title/description so
// the case routes to the right queue. Governed: per-dealer kill switch,
// per-run audit record, prompt-injection guard on the untrusted case text,
// and the MIN_AGENT_CONFIDENCE floor — below it (or on any failure) the case
// simply keeps its human-supplied/default classification (graceful degrade).
// It never touches a classification a human set explicitly.
// ---------------------------------------------------------------------------

const AGENT_KEY = "case_classifier";

export function runCaseClassifier(
  caseRow: CustomerCase,
  opts: { humanSetType: boolean; humanSetSeverity: boolean },
): void {
  void classify(caseRow, opts).catch((err) => {
    logger.error({ err, caseId: caseRow.id }, "Case classifier failed");
  });
}

async function classify(
  caseRow: CustomerCase,
  opts: { humanSetType: boolean; humanSetSeverity: boolean },
): Promise<void> {
  // Nothing to do when the human explicitly set both fields.
  if (opts.humanSetType && opts.humanSetSeverity) return;
  if (!(await isAgentEnabled(caseRow.dealerId, AGENT_KEY))) return;
  const started = Date.now();
  const corpus = [caseRow.title, caseRow.description ?? ""]
    .filter(Boolean)
    .join("\n");

  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 250,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                `You classify a car-dealership customer case. Respond with ONLY a JSON object like ` +
                `{"type":"complaint","severity":"medium","confidence":0.85,"rationale":"…"} where type is exactly one of ` +
                `${CASE_TYPES.join(", ")}; severity is exactly one of ${CASE_SEVERITIES.join(", ")}; confidence is 0-1; ` +
                `rationale is one short sentence.\n\nCase text:\n${guardUntrusted("case_text", corpus, 2000)}`,
            },
          ],
        },
      ],
    });
    const textBlock = message.content.find((b) => b.type === "text");
    const raw = textBlock && textBlock.type === "text" ? textBlock.text : "";
    const s = raw.indexOf("{");
    const e = raw.lastIndexOf("}");
    if (s === -1 || e === -1) throw new Error("No JSON in classifier reply");
    const parsed = JSON.parse(raw.slice(s, e + 1)) as {
      type?: string;
      severity?: string;
      confidence?: number;
      rationale?: string;
    };
    const type = (CASE_TYPES as readonly string[]).includes(parsed.type ?? "")
      ? (parsed.type as CaseType)
      : null;
    const severity = (CASE_SEVERITIES as readonly string[]).includes(
      parsed.severity ?? "",
    )
      ? (parsed.severity as CaseSeverity)
      : null;
    const confidence =
      typeof parsed.confidence === "number" ? parsed.confidence : null;

    // Confidence floor (R3.5): below MIN_AGENT_CONFIDENCE the classification
    // is NOT applied — the case keeps its defaults and a human triages it.
    const gate = confidenceGateReason(confidence, { requireConfidence: true });
    if (gate || (!type && !severity)) {
      await recordAgentRun({
        dealerId: caseRow.dealerId,
        agentKey: AGENT_KEY,
        runType: "case_classification",
        inputSource: "cases",
        inputSummary: `Case #${caseRow.id}: ${caseRow.title}`,
        outputSummary: `Proposed ${parsed.type ?? "?"}/${parsed.severity ?? "?"} — NOT applied`,
        confidence,
        status: "needs_review",
        reviewReason: gate ?? "Classifier returned no usable classification",
        refType: "case",
        refId: caseRow.id,
        latencyMs: Date.now() - started,
      });
      return;
    }

    const set: Partial<{ type: string; severity: string }> = {};
    if (type && !opts.humanSetType) set.type = type;
    if (severity && !opts.humanSetSeverity) set.severity = severity;
    if (Object.keys(set).length === 0) return;

    const [updated] = await db
      .update(casesTable)
      .set(set)
      .where(
        and(
          eq(casesTable.id, caseRow.id),
          eq(casesTable.dealerId, caseRow.dealerId),
          // Only classify cases still sitting untouched at the top of the funnel.
          eq(casesTable.status, "open"),
        ),
      )
      .returning();
    if (!updated) return;

    await recordAgentRun({
      dealerId: caseRow.dealerId,
      agentKey: AGENT_KEY,
      runType: "case_classification",
      inputSource: "cases",
      inputSummary: `Case #${caseRow.id}: ${caseRow.title}`,
      outputSummary: `Classified as ${updated.type}/${updated.severity} — ${parsed.rationale ?? ""}`,
      confidence,
      mutation: true,
      autonomy: "autonomous",
      refType: "case",
      refId: caseRow.id,
      changeSummary: `type ${caseRow.type} → ${updated.type}; severity ${caseRow.severity} → ${updated.severity}`,
      latencyMs: Date.now() - started,
    });

    if (caseRow.customerId != null) {
      await db.insert(timelineEventsTable).values({
        dealerId: caseRow.dealerId,
        customerId: caseRow.customerId,
        domain: "customers",
        kind: "note",
        title: `Case #${caseRow.id} classified ${updated.type}/${updated.severity}`,
        detail: parsed.rationale ?? "Classified by the case classifier agent.",
        actor: "AURA Case Classifier",
        isAgent: true,
        refType: "customer",
        refId: caseRow.customerId,
      });
    }
  } catch (err) {
    // Graceful degrade: the case stays open with its defaults.
    await recordAgentRun({
      dealerId: caseRow.dealerId,
      agentKey: AGENT_KEY,
      runType: "case_classification",
      inputSource: "cases",
      inputSummary: `Case #${caseRow.id}: ${caseRow.title}`,
      status: "error",
      errorMessage: err instanceof Error ? err.message : String(err),
      refType: "case",
      refId: caseRow.id,
      latencyMs: Date.now() - started,
    });
  }
}
