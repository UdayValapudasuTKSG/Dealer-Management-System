import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const CALL_DIRECTIONS = ["outbound", "inbound"] as const;
export type CallDirection = (typeof CALL_DIRECTIONS)[number];

export const CALL_STATUSES = [
  "in_progress",
  "completed",
  "no_answer",
  "busy",
  "voicemail",
] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

export const CALL_SENTIMENTS = ["positive", "neutral", "negative"] as const;
export type CallSentiment = (typeof CALL_SENTIMENTS)[number];

// One row per call — the single activity record for a click-to-call session.
export const callLogsTable = pgTable("call_logs", {
  id: serial("id").primaryKey(),
  dealerId: integer("dealer_id").notNull(),
  leadId: integer("lead_id").notNull(),
  direction: text("direction").notNull().default("outbound"),
  status: text("status").notNull().default("completed"),
  durationSeconds: integer("duration_seconds"),
  sentiment: text("sentiment").notNull().default("neutral"),
  notes: text("notes"),
  // Telephony adapter seam (PENDING-INFRA): which provider placed the call
  // and its call id. The stub adapter writes provider = "stub".
  provider: text("provider").notNull().default("stub"),
  providerCallId: text("provider_call_id"),
  // Two-party conversation capture: Twilio dual-channel recording + AI
  // transcript. transcriptStatus: none | pending | completed | failed.
  recordingSid: text("recording_sid"),
  recordingUrl: text("recording_url"),
  transcript: text("transcript"),
  transcriptStatus: text("transcript_status").notNull().default("none"),
  actor: text("actor").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertCallLogSchema = createInsertSchema(callLogsTable, {
  direction: z.enum(CALL_DIRECTIONS),
  status: z.enum(CALL_STATUSES),
  sentiment: z.enum(CALL_SENTIMENTS),
}).omit({ dealerId: true, id: true, createdAt: true });
export type InsertCallLog = z.infer<typeof insertCallLogSchema>;
export type CallLog = typeof callLogsTable.$inferSelect;
