import {
  pgTable,
  serial,
  text,
  integer,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const AUDIT_ACTIONS = [
  "login",
  "logout",
  "create",
  "update",
  "delete",
  "approve",
  "reject",
  "assign",
  "export",
  "impersonate",
  "suspend",
  "activate",
  "access_denied",
  "provision",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const auditLogsTable = pgTable(
  "audit_logs",
  {
    id: serial("id").primaryKey(),
  dealerId: integer("dealer_id"),
    actorUserId: integer("actor_user_id"),
    actorClerkId: text("actor_clerk_id"),
    actorName: text("actor_name"),
    actorEmail: text("actor_email"),
    action: text("action").notNull(),
    module: text("module").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    summary: text("summary").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>(),
    statusCode: integer("status_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("audit_logs_created_at_idx").on(t.createdAt),
    index("audit_logs_action_idx").on(t.action),
    index("audit_logs_module_idx").on(t.module),
  ],
);

export const insertAuditLogSchema = createInsertSchema(auditLogsTable, {
  action: z.enum(AUDIT_ACTIONS),
}).omit({ dealerId: true, id: true, createdAt: true });

export type InsertAuditLog = z.infer<typeof insertAuditLogSchema>;
export type AuditLog = typeof auditLogsTable.$inferSelect;
