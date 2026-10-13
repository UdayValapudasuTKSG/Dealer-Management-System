import { boolean, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

export const feedbackAutomationTable = pgTable("feedback_automation", {
  dealerId: integer("dealer_id").notNull(),
  kind: text("kind").$type<"sales" | "service">().notNull(),
  enabled: boolean("enabled").notNull().default(false),
  formId: integer("form_id"),
  delayDays: integer("delay_days").notNull().default(2),
  channels: jsonb("channels").$type<Array<"email" | "whatsapp">>().notNull().default(["email"]),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.dealerId, t.kind] })]);
