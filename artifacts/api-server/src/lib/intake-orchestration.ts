import { and, desc, eq } from "drizzle-orm";
import {
  db,
  leadsTable,
  quotesTable,
  timelineEventsTable,
  dealersTable,
  type Lead,
} from "@workspace/db";
import { whatsappConfig } from "./whatsapp";
import { isAgentEnabled, recordAgentRun } from "./agent-governance";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Intake orchestration agent — runs once per newly created lead, AFTER the
// existing intake side-effects (model match, quote generation, auto-assign):
//   1. Nearest-showroom selection from the customer's address / branch hints
//      (deterministic demo mapping — no geocoding service) → preferredBranch.
//   2. Auto-quote share over WhatsApp when the lead has a phone number and
//      the dealer has WhatsApp configured (email share is handled by the
//      lifecycle email triggers already).
//   3. One governance record for the whole orchestration.
// Fire-and-forget: never throws into the request path.
// ---------------------------------------------------------------------------

const AGENT_KEY = "intake_dedup";
const AGENT_ACTOR = "AURA Intake Agent";

/** Demo showrooms with the address keywords that map to them. */
const SHOWROOMS: { name: string; keywords: string[] }[] = [
  {
    name: "Georgetown Showroom",
    keywords: [
      "georgetown",
      "kitty",
      "campbellville",
      "bel air",
      "kingston",
      "queenstown",
      "alberttown",
    ],
  },
  {
    name: "Providence Showroom",
    keywords: ["providence", "diamond", "grove", "eccles", "east bank", "ebd"],
  },
  {
    name: "Berbice Showroom",
    keywords: [
      "berbice",
      "new amsterdam",
      "rose hall",
      "corriverton",
      "skeldon",
    ],
  },
  {
    name: "Linden Showroom",
    keywords: ["linden", "wismar", "mackenzie"],
  },
];

const DEFAULT_SHOWROOM = "Georgetown Showroom";

/** Deterministic nearest-showroom pick from free-text address hints. */
export function nearestShowroom(
  ...hints: (string | null | undefined)[]
): { name: string; matched: string | null } {
  const text = hints.filter(Boolean).join(" ").toLowerCase();
  if (text.trim()) {
    for (const s of SHOWROOMS) {
      const hit = s.keywords.find((k) => text.includes(k));
      if (hit) return { name: s.name, matched: hit };
    }
  }
  return { name: DEFAULT_SHOWROOM, matched: null };
}

async function latestQuoteSummary(lead: Lead): Promise<string | null> {
  // The quote agent runs async right before us — give it a moment.
  for (let attempt = 0; attempt < 3; attempt++) {
    const [q] = await db
      .select()
      .from(quotesTable)
      .where(
        and(
          eq(quotesTable.dealerId, lead.dealerId),
          eq(quotesTable.leadId, lead.id),
        ),
      )
      .orderBy(desc(quotesTable.version))
      .limit(1);
    if (q) {
      return (
        `${q.modelYear} ${q.vehicleLine}${q.color ? ` (${q.color})` : ""} — ` +
        `estimate ${q.quoteNumber}: total USD $${q.total.toLocaleString("en-US")} ` +
        `incl. taxes, valid until ${q.validUntil}.`
      );
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  return null;
}

async function dealerName(dealerId: number): Promise<string> {
  const [d] = await db
    .select({ name: dealersTable.name })
    .from(dealersTable)
    .where(eq(dealersTable.id, dealerId));
  return d?.name ?? "our dealership";
}

async function orchestrate(lead: Lead): Promise<void> {
  if (!(await isAgentEnabled(lead.dealerId, AGENT_KEY))) return;
  const started = Date.now();
  const actions: string[] = [];

  // 1) Nearest showroom → preferredBranch (only when the customer didn't pick one).
  const [fresh] = await db
    .select()
    .from(leadsTable)
    .where(
      and(eq(leadsTable.id, lead.id), eq(leadsTable.dealerId, lead.dealerId)),
    );
  if (!fresh) return;
  if (!fresh.preferredBranch) {
    const pick = nearestShowroom(fresh.address, fresh.notes);
    await db
      .update(leadsTable)
      .set({ preferredBranch: pick.name })
      .where(eq(leadsTable.id, fresh.id));
    const why = pick.matched
      ? `Matched "${pick.matched}" in the customer's address details.`
      : "No location details on the enquiry — defaulted to the flagship showroom.";
    await db.insert(timelineEventsTable).values({
      dealerId: fresh.dealerId,
      customerId: fresh.customerId,
      domain: "leads",
      kind: "branch_selected",
      title: `Nearest showroom: ${pick.name}`,
      detail: `${why} Test drives and handover will default to this branch.`,
      actor: AGENT_ACTOR,
      isAgent: true,
      refType: "lead",
      refId: fresh.id,
    });
    actions.push(
      `nearest showroom → ${pick.name}${pick.matched ? ` (matched "${pick.matched}")` : " (default)"}`,
    );
  }

  // 2) WhatsApp quote share — DRAFT ONLY (R3.3 / NC: no customer-facing
  // message is ever auto-sent). The drafted message is held as a
  // needs_review outreach run; a human approves and sends it via the
  // Approve & Send flow.
  if (fresh.phone && fresh.interestedVehicleId && whatsappConfig()) {
    const summary = await latestQuoteSummary(fresh);
    if (summary) {
      const dealer = await dealerName(fresh.dealerId);
      const body =
        `Hi ${fresh.name.split(" ")[0]}, thanks for your enquiry with ${dealer}! ` +
        `Here is your personalised estimate: ${summary} ` +
        `${fresh.assignedTo ? `${fresh.assignedTo} is your advisor and ` : "Our team "}will be in touch shortly — reply here any time.`;
      await recordAgentRun({
        dealerId: fresh.dealerId,
        agentKey: "outreach",
        runType: "whatsapp_quote_draft",
        inputSource: "leads",
        inputSummary: `New ${fresh.channel} lead #${fresh.id} with a priced quote`,
        outputSummary: `Draft WhatsApp quote message: ${body}`,
        status: "needs_review",
        reviewReason:
          "Customer-facing message — requires human Approve & Send (never auto-sent)",
        refType: "lead",
        refId: fresh.id,
      });
      actions.push("WhatsApp quote drafted for human review (not sent)");
    }
  }

  if (actions.length > 0) {
    await recordAgentRun({
      dealerId: fresh.dealerId,
      agentKey: AGENT_KEY,
      runType: "intake_orchestration",
      inputSource: "leads",
      inputSummary: `New ${fresh.channel} lead via ${fresh.source}`,
      outputSummary: actions.join("; "),
      refType: "lead",
      refId: fresh.id,
      latencyMs: Date.now() - started,
      mutation: true,
    });
  }
}

/** Fire-and-forget intake orchestration hook — never fails the request. */
export function runIntakeOrchestration(lead: Lead): void {
  void orchestrate(lead).catch((err) => {
    logger.error({ err, leadId: lead.id }, "Intake orchestration failed");
  });
}
