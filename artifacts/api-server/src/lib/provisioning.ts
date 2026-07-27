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
  { key: "concierge", name: "Concierge", domain: "Customer Experience", description: "Greets and qualifies inbound customers across chat and WhatsApp.", status: "active" },
  { key: "sales", name: "Sales", domain: "Sales & Pipeline", description: "Captures enquiries, auto-assigns leads, and desks draft deals.", status: "active" },
  { key: "appraisal", name: "Appraisal", domain: "Trade-In", description: "Assists with trade-in valuations and appraisal intake.", status: "active" },
  { key: "finance", name: "F&I", domain: "Finance & Insurance", description: "Prepares finance applications and routes them to lenders.", status: "active" },
  { key: "inventory", name: "Inventory", domain: "Stock & Merchandising", description: "Keeps stock records current and flags ageing units.", status: "active" },
  { key: "gra_extract", name: "GRA Extract Agent", domain: "Compliance & Import", description: "Transcribes legible fields from import documents for GRA duty filings (server computes the duty).", status: "idle" },
  { key: "scheduler", name: "Scheduler", domain: "Appointments", description: "Books test drives and service appointments.", status: "active" },
  { key: "service", name: "Service", domain: "Aftersales", description: "Drafts service orders and keeps customers informed.", status: "active" },
  { key: "parts", name: "Parts", domain: "Parts & Supply", description: "Monitors parts stock and suggests reorders.", status: "active" },
  { key: "ledger", name: "Ledger", domain: "Accounting", description: "Reconciles invoices and payments.", status: "active" },
  { key: "retention", name: "Retention", domain: "Loyalty & Win-back", description: "Runs follow-ups and win-back outreach.", status: "active" },
  { key: "analyst", name: "Analyst", domain: "Intelligence", description: "Analyzes call sentiment and pipeline health.", status: "idle" },
  { key: "documents", name: "Documents", domain: "leads", description: "Extracts and files customer documents.", status: "active" },
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
