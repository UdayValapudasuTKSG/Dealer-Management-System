import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Call notes and meeting notes logged against a customer.
export const commNotesTable = pgTable("comm_notes", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id").notNull(),
  kind: text("kind").notNull(),
  subject: text("subject").notNull(),
  notes: text("notes"),
  outcome: text("outcome"),
  loggedBy: text("logged_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertCommNoteSchema = createInsertSchema(commNotesTable, {
  kind: z.enum(["call", "meeting"]),
}).omit({ id: true, createdAt: true });
export type InsertCommNote = z.infer<typeof insertCommNoteSchema>;
export type CommNote = typeof commNotesTable.$inferSelect;
