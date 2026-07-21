import {
  pgTable,
  serial,
  text,
  integer,
  doublePrecision,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const AGENT_RUN_STATUSES = [
  "completed",
  "accepted",
  "overridden",
  "error",
  "blocked",
  "needs_review",
] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

/**
 * Whether the run only advised a human (suggestions, drafts, analyses) or
 * autonomously wrote state (created/updated records without a human in the
 * loop). Autonomous runs surface distinctly in the governance console.
 */
export const AGENT_RUN_AUTONOMY = ["advisory", "autonomous"] as const;
export type AgentRunAutonomy = (typeof AGENT_RUN_AUTONOMY)[number];

export type AgentRunAffectedEntity = { type: string; id: number };

/**
 * Per-invocation audit record for every AI agent run: what triggered it,
 * a PII-minimized summary of the input and output, model confidence when
 * available, and the human review outcome (accepted / overridden).
 */
export const agentRunsTable = pgTable(
  "agent_runs",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    agentKey: text("agent_key").notNull(),
    runType: text("run_type").notNull(),
    inputSource: text("input_source").notNull(),
    inputSummary: text("input_summary"),
    outputSummary: text("output_summary"),
    confidence: doublePrecision("confidence"),
    status: text("status").notNull().default("completed"),
    errorMessage: text("error_message"),
    refType: text("ref_type"),
    refId: integer("ref_id"),
    /** advisory | autonomous — autonomous runs changed records without a human. */
    autonomy: text("autonomy").notNull().default("advisory"),
    /** Every entity the run created or changed, e.g. [{type:"lead",id:12}]. */
    affectedEntities: jsonb("affected_entities")
      .$type<AgentRunAffectedEntity[]>()
      .notNull()
      .default([]),
    /** Short before → after description of what the run changed. */
    changeSummary: text("change_summary"),
    /** Why the output was held for human review (e.g. below confidence floor). */
    reviewReason: text("review_reason"),
    latencyMs: integer("latency_ms"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("agent_runs_dealer_created_idx").on(t.dealerId, t.createdAt),
    index("agent_runs_agent_key_idx").on(t.agentKey),
  ],
);

export const insertAgentRunSchema = createInsertSchema(agentRunsTable, {
  status: z.enum(AGENT_RUN_STATUSES),
  autonomy: z.enum(AGENT_RUN_AUTONOMY),
}).omit({ id: true, createdAt: true });

export type InsertAgentRun = z.infer<typeof insertAgentRunSchema>;
export type AgentRun = typeof agentRunsTable.$inferSelect;
