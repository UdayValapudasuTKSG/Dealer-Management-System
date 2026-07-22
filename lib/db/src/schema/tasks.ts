import {
  pgTable,
  serial,
  text,
  integer,
  date,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { leadsTable } from "./leads";

export type TaskAttachment = { name: string; url: string };

export const tasksTable = pgTable("tasks", {
  id: serial("id").primaryKey(),
  dealerId: integer("dealer_id").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  assigneeUserId: integer("assignee_user_id").references(() => usersTable.id, {
    onDelete: "set null",
  }),
  createdByUserId: integer("created_by_user_id").references(
    () => usersTable.id,
    { onDelete: "set null" },
  ),
  leadId: integer("lead_id").references(() => leadsTable.id, {
    onDelete: "set null",
  }),
  dueDate: date("due_date", { mode: "string" }),
  // Precise due timestamp for time-of-day commitments (callback promises);
  // dueDate stays the day-level field the task views sort on.
  dueAt: timestamp("due_at", { withTimezone: true }),
  // Provenance: "manual" (user-created), "cadence" (follow-up cadence agent)
  // or "callback" (customer-requested callback). System kinds are safe to
  // auto-close when the cadence resolves; manual tasks are never touched.
  kind: text("kind").notNull().default("manual"),
  priority: text("priority").notNull().default("normal"),
  status: text("status").notNull().default("open"),
  attachments: jsonb("attachments")
    .$type<TaskAttachment[]>()
    .notNull()
    .default([]),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  dueSoonNotifiedAt: timestamp("due_soon_notified_at", { withTimezone: true }),
  overdueNotifiedAt: timestamp("overdue_notified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const taskCommentsTable = pgTable("task_comments", {
  id: serial("id").primaryKey(),
  dealerId: integer("dealer_id").notNull(),
  taskId: integer("task_id")
    .notNull()
    .references(() => tasksTable.id, { onDelete: "cascade" }),
  authorUserId: integer("author_user_id").references(() => usersTable.id, {
    onDelete: "set null",
  }),
  authorName: text("author_name").notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertTaskSchema = createInsertSchema(tasksTable, {
  priority: z.enum(["low", "normal", "high", "urgent"]),
  status: z.enum(["open", "in_progress", "done"]),
}).omit({ dealerId: true,
  id: true,
  kind: true,
  dueAt: true,
  createdAt: true,
  updatedAt: true,
  completedAt: true,
  dueSoonNotifiedAt: true,
  overdueNotifiedAt: true,
});
export const insertTaskCommentSchema = createInsertSchema(
  taskCommentsTable,
).omit({ dealerId: true, id: true, createdAt: true });

export type InsertTask = z.infer<typeof insertTaskSchema>;
export type Task = typeof tasksTable.$inferSelect;
export type InsertTaskComment = z.infer<typeof insertTaskCommentSchema>;
export type TaskComment = typeof taskCommentsTable.$inferSelect;
