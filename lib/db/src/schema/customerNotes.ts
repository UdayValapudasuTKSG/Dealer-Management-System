import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { customersTable } from "./customers";

export const customerNotesTable = pgTable("customer_notes", {
  id: serial("id").primaryKey(),
  dealerId: integer("dealer_id").notNull(),
  customerId: integer("customer_id")
    .notNull()
    .references(() => customersTable.id, { onDelete: "cascade" }),
  body: text("body").notNull(),
  author: text("author"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertCustomerNoteSchema = createInsertSchema(
  customerNotesTable,
).omit({ dealerId: true, id: true, createdAt: true });
export type InsertCustomerNote = z.infer<typeof insertCustomerNoteSchema>;
export type CustomerNote = typeof customerNotesTable.$inferSelect;
