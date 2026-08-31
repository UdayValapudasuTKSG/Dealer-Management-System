import { eq, inArray } from "drizzle-orm";
import {
  db,
  dealersTable,
  divisionsTable,
  rolesTable,
  rolePermissionsTable,
  stageChecklistsTable,
  agentsTable,
  ROLE_DEFAULTS,
  DEFAULT_STAGE_CHECKLISTS,
  CHECKLIST_STAGES,
  type Dealer,
  type InsertDealer,
} from "@workspace/db";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Default division catalog every dealership starts with. */
const DEFAULT_DIVISIONS: { name: string; code: "CAM" | "GT" }[] = [
  { name: "CAM Motors", code: "CAM" },
  { name: "GT Automotive", code: "GT" },
];

/** Default AI agent catalog provisioned for every new dealership. */
export const DEFAULT_AGENTS: {
  key: string;
  name: string;
  domain: string;
  description: string;
  status: string;
}[] = [
  // Autonomous internal writers (A1/A6/A16) — audited, kill-switchable, never customer-facing.
  { key: "intake_dedup", name: "Intake & Dedup", domain: "Lead Intake", description: "Parses inbound enquiries (email/WhatsApp/web), dedupes against existing leads and creates or merges the lead record.", status: "active" },
  { key: "call_sentiment", name: "Call Sentiment", domain: "Sales Calls", description: "Analyzes call transcripts and notes, writing sentiment and summary onto the call log.", status: "active" },
  { key: "case_classifier", name: "Case Classifier", domain: "Aftersales", description: "Classifies new service cases (type and severity) so they route to the right queue.", status: "active" },
  { key: "collision_coordinator", name: "Collision Coordinator", domain: "Service & Repair", description: "Routes collision claim handoffs, approval reminders and finance actions while leaving protected decisions to staff.", status: "active" },
  // HITL / advisory — draft, suggest, extract or navigate; a human commits every action.
  { key: "doc_prefill", name: "Document Prefill", domain: "Documents", description: "Extracts fields from uploaded customer documents to prefill forms — a human verifies before use.", status: "active" },
  { key: "outreach", name: "Outreach Drafts", domain: "Sales & Pipeline", description: "Drafts customer messages for human Approve & Send — never sends on its own.", status: "active" },
  { key: "test_drive_availability", name: "Test-Drive Availability", domain: "Appointments", description: "Suggests test-drive slots and detects booking intent — a human confirms the booking.", status: "active" },
  { key: "pipeline_suggestions", name: "Pipeline Suggestions", domain: "Sales & Pipeline", description: "Surfaces next-best actions, stage-advance proposals and lead briefs for advisors.", status: "active" },
  { key: "sentiment_digest", name: "Sentiment Digest", domain: "Intelligence", description: "Summarizes customer sentiment across recent interactions for the daily briefing.", status: "active" },
  { key: "persona_recommend", name: "Persona & Recommendations", domain: "Customer Experience", description: "Builds customer personas and recommends vehicles for advisors to present.", status: "active" },
  { key: "concierge", name: "Concierge", domain: "In-App Assistant", description: "In-app navigation and Q&A assistant for staff — never messages customers.", status: "active" },
  { key: "gra_extract", name: "GRA Extract", domain: "Compliance & Import", description: "Transcribes legible fields from import documents for GRA duty filings (server computes the duty).", status: "idle" },
];

/** Idempotently ensure the global default role catalog exists (roles are
 * shared across dealers; a wiped roles table breaks every login). */
export async function ensureDefaultRoles(tx: Tx | typeof db = db) {
  const existing = await tx
    .select({ id: rolesTable.id, name: rolesTable.name })
    .from(rolesTable)
    .where(inArray(rolesTable.name, ROLE_DEFAULTS.map((r) => r.name)));
  const byName = new Map(existing.map((r) => [r.name, r.id]));
  for (const role of ROLE_DEFAULTS) {
    if (byName.has(role.name)) continue;
    const [created] = await tx
      .insert(rolesTable)
      .values({
        name: role.name,
        description: role.description,
        isSystem: true,
        createdBy: "system",
      })
      .returning();
    const rows = Object.entries(role.grants).flatMap(([module, categories]) =>
      (categories ?? []).map((category) => ({
        roleId: created!.id,
        module,
        category,
      })),
    );
    if (rows.length > 0) {
      await tx.insert(rolePermissionsTable).values(rows).onConflictDoNothing();
    }
  }
}

/**
 * Create a dealer fully provisioned in ONE transaction: divisions, default
 * roles (global, ensured if missing), stage checklists v1, and the AI agent
 * catalog (all switches in their default state).
 */
export async function createDealerProvisioned(
  values: InsertDealer,
): Promise<Dealer> {
  return db.transaction(async (tx) => {
    const [dealer] = await tx.insert(dealersTable).values(values).returning();
    const dealerId = dealer!.id;

    await ensureDefaultRoles(tx);

    await tx.insert(divisionsTable).values(
      DEFAULT_DIVISIONS.map((d) => ({ dealerId, name: d.name, code: d.code })),
    );

    await tx.insert(stageChecklistsTable).values(
      CHECKLIST_STAGES.map((stage) => ({
        dealerId,
        stage,
        version: 1,
        items: DEFAULT_STAGE_CHECKLISTS[stage],
        createdBy: "provisioning",
      })),
    );

    await tx.insert(agentsTable).values(
      DEFAULT_AGENTS.map((a) => ({ dealerId, ...a })),
    );

    return dealer!;
  });
}

/** Pause every agent for a dealer (used when a dealership is suspended). */
export async function pauseDealerAgents(dealerId: number): Promise<number> {
  const rows = await db
    .update(agentsTable)
    .set({ status: "paused" })
    .where(eq(agentsTable.dealerId, dealerId))
    .returning({ id: agentsTable.id });
  return rows.length;
}
