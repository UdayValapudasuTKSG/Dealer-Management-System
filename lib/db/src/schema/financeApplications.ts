import {
  pgTable,
  serial,
  text,
  integer,
  doublePrecision,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const FINANCE_STATUSES = [
  "pending",
  "submitted",
  "under_review",
  "approved",
  "declined",
  "disbursed",
] as const;
export type FinanceStatus = (typeof FINANCE_STATUSES)[number];

export const EMPLOYMENT_TYPES = [
  "employed",
  "self_employed",
  "contract",
  "retired",
  "other",
] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export type FinanceStatusEvent = {
  status: string;
  note: string;
  at: string;
};

export const financeApplicationsTable = pgTable("finance_applications", {
  id: serial("id").primaryKey(),
  dealerId: integer("dealer_id").notNull(),
  dealId: integer("deal_id"),
  leadId: integer("lead_id"),
  customerId: integer("customer_id"),
  customerName: text("customer_name").notNull(),
  amount: doublePrecision("amount").notNull(),
  downPayment: doublePrecision("down_payment").notNull().default(0),
  termMonths: integer("term_months").notNull(),
  apr: doublePrecision("apr").notNull(),
  lender: text("lender"),
  bankId: integer("bank_id"),
  employerName: text("employer_name"),
  jobTitle: text("job_title"),
  employmentType: text("employment_type"),
  employmentYears: doublePrecision("employment_years"),
  monthlyIncome: doublePrecision("monthly_income"),
  otherIncome: doublePrecision("other_income"),
  status: text("status").notNull().default("pending"),
  statusHistory: jsonb("status_history")
    .$type<FinanceStatusEvent[]>()
    .notNull()
    .default([]),
  losConnector: text("los_connector"),
  losReference: text("los_reference"),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  decisionAt: timestamp("decision_at", { withTimezone: true }),
  disbursedAt: timestamp("disbursed_at", { withTimezone: true }),
  protectionProducts: text("protection_products").array().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertFinanceApplicationSchema = createInsertSchema(
  financeApplicationsTable,
  {
    status: z.enum(FINANCE_STATUSES),
    employmentType: z.enum(EMPLOYMENT_TYPES).nullable().optional(),
  },
).omit({ dealerId: true, id: true, createdAt: true, statusHistory: true });
export type InsertFinanceApplication = z.infer<
  typeof insertFinanceApplicationSchema
>;
export type FinanceApplication =
  typeof financeApplicationsTable.$inferSelect;
