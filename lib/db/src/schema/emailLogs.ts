import {
  pgTable,
  serial,
  text,
  integer,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const EMAIL_TEMPLATES = [
  "lead_received",
  "vehicle_quote",
  "test_drive_invite",
  "test_drive_confirmation",
  "test_drive_owner_invite",
  "lead_assignment",
  "finance_processing",
  "finance_approved",
  "vehicle_booking",
  "payment_reminder",
  "vehicle_ready",
  "delivery_schedule",
  "delivery_confirmation",
  "service_reminder",
  "warranty_reminder",
  "feedback_request",
  "thank_you",
  "outreach",
  "smtp_test",
  "owner_invite",
] as const;
export type EmailTemplate = (typeof EMAIL_TEMPLATES)[number];

/** Non-email outbox kinds (channel = "whatsapp"); stored in the same `template` column. */
export const WHATSAPP_KINDS = [
  "whatsapp_message",
  "test_drive_reminder",
  "outreach",
] as const;
export type WhatsappKind = (typeof WHATSAPP_KINDS)[number];

// The outbox: every outbound email AND WhatsApp message goes through this
// DB-backed queue with retry/backoff (next_attempt_at) and idempotency
// (dedupe_key). channel = "email" | "whatsapp".
export const emailLogsTable = pgTable("email_logs", {
  id: serial("id").primaryKey(),
  dealerId: integer("dealer_id").notNull(),
  customerId: integer("customer_id"),
  leadId: integer("lead_id"),
  recipient: text("recipient").notNull(),
  subject: text("subject").notNull(),
  template: text("template").notNull(),
  channel: text("channel").notNull().default("email"),
  status: text("status").notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  payload: jsonb("payload").$type<Record<string, string>>().notNull().default({}),
  /** Earliest time the worker may (re)try this item — backoff & scheduled sends. */
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  /** Idempotency key — a second enqueue with the same key is a no-op. */
  dedupeKey: text("dedupe_key").unique(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertEmailLogSchema = createInsertSchema(emailLogsTable, {
  template: z.enum(EMAIL_TEMPLATES),
  channel: z.enum(["email", "sms", "whatsapp"]),
  status: z.enum(["queued", "sending", "sent", "failed"]),
}).omit({ dealerId: true, id: true, createdAt: true });
export type InsertEmailLog = z.infer<typeof insertEmailLogSchema>;
export type EmailLog = typeof emailLogsTable.$inferSelect;
