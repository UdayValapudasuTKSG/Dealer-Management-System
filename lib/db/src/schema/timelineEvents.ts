import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const timelineEventsTable = pgTable("timeline_events", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id"),
  domain: text("domain").notNull(),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  detail: text("detail"),
  actor: text("actor").notNull(),
  isAgent: boolean("is_agent").notNull().default(true),
  cause: text("cause"),
  refType: text("ref_type"),
  refId: integer("ref_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertTimelineEventSchema = createInsertSchema(timelineEventsTable, {
  domain: z.enum([
    "leads",
    "deals",
    "finance",
    "appraisals",
    "service",
    "vehicles",
    "gate",
    "system",
  ]),
}).omit({ id: true, createdAt: true });
export type InsertTimelineEvent = z.infer<typeof insertTimelineEventSchema>;
export type TimelineEvent = typeof timelineEventsTable.$inferSelect;
