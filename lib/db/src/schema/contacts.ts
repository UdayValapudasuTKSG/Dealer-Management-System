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
import { customersTable } from "./customers";

// Contacts live under an account (customers table). Person accounts get a
// primary contact mirroring the person; business accounts hold many contacts.
export const contactsTable = pgTable("contacts", {
  id: serial("id").primaryKey(),
  dealerId: integer("dealer_id").notNull(),
  accountId: integer("account_id")
    .notNull()
    .references(() => customersTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  title: text("title"),
  email: text("email"),
  phone: text("phone"),
  isPrimary: boolean("is_primary").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertContactSchema = createInsertSchema(contactsTable).omit({
  id: true,
  dealerId: true,
  accountId: true,
  createdAt: true,
});
export type InsertContact = z.infer<typeof insertContactSchema>;
export type Contact = typeof contactsTable.$inferSelect;
