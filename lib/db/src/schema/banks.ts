import {
  pgTable,
  serial,
  text,
  integer,
  doublePrecision,
  boolean,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const banksTable = pgTable("banks", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  code: text("code"),
  contactEmail: text("contact_email"),
  contactPhone: text("contact_phone"),
  address: text("address"),
  baseApr: doublePrecision("base_apr"),
  maxTermMonths: integer("max_term_months"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertBankSchema = createInsertSchema(banksTable).omit({
  id: true,
  createdAt: true,
});
export type InsertBank = z.infer<typeof insertBankSchema>;
export type Bank = typeof banksTable.$inferSelect;
