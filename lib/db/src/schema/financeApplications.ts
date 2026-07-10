import {
  pgTable,
  serial,
  text,
  integer,
  doublePrecision,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const financeApplicationsTable = pgTable("finance_applications", {
  id: serial("id").primaryKey(),
  dealId: integer("deal_id"),
  customerId: integer("customer_id"),
  customerName: text("customer_name").notNull(),
  amount: doublePrecision("amount").notNull(),
  termMonths: integer("term_months").notNull(),
  apr: doublePrecision("apr").notNull(),
  lender: text("lender"),
  status: text("status").notNull().default("submitted"),
  protectionProducts: text("protection_products").array().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertFinanceApplicationSchema = createInsertSchema(
  financeApplicationsTable,
).omit({ id: true, createdAt: true });
export type InsertFinanceApplication = z.infer<
  typeof insertFinanceApplicationSchema
>;
export type FinanceApplication =
  typeof financeApplicationsTable.$inferSelect;
