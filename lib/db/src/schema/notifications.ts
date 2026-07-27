import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

/**
 * R6 notification types — one per matrix trigger — plus the legacy
 * generic buckets still used by tasks/approvals/system notices.
 */
export const NOTIFICATION_TYPES = [
  "approval",
  "assignment",
  "task",
  "email",
  "system",
  // R6.2 matrix trigger types
  "lead.new",
  "lead.assigned",
  "lead.sla.reminder",
  "lead.sla.breach.advisor",
  "lead.sla.breach.manager",
  "testdrive.reminder.advisor",
  "reservation.pending",
  "invoice.generated",
  "document.missing.internal",
  "cancellation.manager",
  "refund.approved.finance",
  "delivery.ready",
  "delivered.service.handoff",
  "case.opened",
  "manager.note.advisor",
  "service.cadence.due",
  "channel.delivery.failed",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

// In-App is the PRIMARY notification channel (R6.1): rows are written
// transactionally with the triggering event and deduped on the natural key
// (dealerId, userId, type, entityType, entityId) — a repeat trigger bumps
// updatedAt/read instead of stacking rows.
export const notificationsTable = pgTable(
  "notifications",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    type: text("type").notNull().default("system"),
    title: text("title").notNull(),
    body: text("body"),
    link: text("link"),
    /** Natural-key entity scope, e.g. ("lead", 42) — null for ad-hoc notices. */
    entityType: text("entity_type"),
    entityId: integer("entity_id"),
    read: boolean("read").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("notifications_natural_key_idx")
      .on(t.dealerId, t.userId, t.type, t.entityType, t.entityId)
      .where(sql`entity_type is not null and entity_id is not null`),
  ],
);

export const insertNotificationSchema = createInsertSchema(notificationsTable, {
  type: z.enum(NOTIFICATION_TYPES),
}).omit({ dealerId: true, id: true, createdAt: true, updatedAt: true });
export type InsertNotification = z.infer<typeof insertNotificationSchema>;
export type Notification = typeof notificationsTable.$inferSelect;
