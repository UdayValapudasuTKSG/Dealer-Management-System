import { pgTable, serial, text, boolean, timestamp } from "drizzle-orm/pg-core";

/**
 * Platform agent-policy library (P4 governance): GLOBAL, cross-tenant policy
 * per agent semantic key. A key disabled here is off for EVERY dealer,
 * regardless of per-dealer kill switches (global overrides local). The
 * special key `__all__` is the platform master kill switch: disabled → every
 * AI agent on the platform is off.
 *
 * Missing rows fail OPEN (enabled) so the policy library is opt-in and never
 * silently disables agents for lack of seed data.
 */
export const AGENT_POLICY_MASTER_KEY = "__all__" as const;

export const agentPoliciesTable = pgTable("agent_policies", {
  id: serial("id").primaryKey(),
  /** Agent semantic key (matches agents.key) or `__all__` for the master switch. */
  agentKey: text("agent_key").notNull().unique(),
  enabled: boolean("enabled").notNull().default(true),
  /** Operator note: why this policy is set (incident, compliance, rollout). */
  note: text("note"),
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export type AgentPolicy = typeof agentPoliciesTable.$inferSelect;

/**
 * Offboarding SAGA step keys (P3), stored in the same provisioning_steps
 * ledger (step keys are disjoint from provisioning keys). Ordered:
 * freeze writes → build/deliver export bundle → start retention clock.
 */
export const OFFBOARDING_STEP_KEYS = [
  "freeze_writes",
  "export_bundle",
  "deliver_export",
  "retention_clock",
] as const;
export type OffboardingStepKey = (typeof OFFBOARDING_STEP_KEYS)[number];
