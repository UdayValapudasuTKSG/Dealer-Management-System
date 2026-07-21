import {
  pgTable,
  serial,
  text,
  integer,
  doublePrecision,
  timestamp,
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
] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

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
}).omit({ id: true, createdAt: true });

export type InsertAgentRun = z.infer<typeof insertAgentRunSchema>;
export type AgentRun = typeof agentRunsTable.$inferSelect;
