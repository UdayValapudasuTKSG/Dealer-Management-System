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
  "smtp_test",
] as const;
export type EmailTemplate = (typeof EMAIL_TEMPLATES)[number];

// channel leaves room for future SMS / WhatsApp providers
export const emailLogsTable = pgTable("email_logs", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id"),
  recipient: text("recipient").notNull(),
  subject: text("subject").notNull(),
  template: text("template").notNull(),
  channel: text("channel").notNull().default("email"),
  status: text("status").notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  payload: jsonb("payload").$type<Record<string, string>>().notNull().default({}),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertEmailLogSchema = createInsertSchema(emailLogsTable, {
  template: z.enum(EMAIL_TEMPLATES),
  channel: z.enum(["email", "sms", "whatsapp"]),
  status: z.enum(["queued", "sending", "sent", "failed"]),
}).omit({ id: true, createdAt: true });
export type InsertEmailLog = z.infer<typeof insertEmailLogSchema>;
export type EmailLog = typeof emailLogsTable.$inferSelect;
