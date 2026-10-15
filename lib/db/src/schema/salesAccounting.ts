import { pgTable, integer, serial, text, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";

export type SalesAccountingConfigData = {
  customerCharges?: { category: "registration" | "fuel" | "detailing"; incomeAccount: string; taxTreatment: "pending" | "taxable" | "exempt" | "zero_rated"; vatRate: number; amountIncludesVat: boolean; approved: boolean; approvalReference: string }[];
  accounts: { key: string; account: string }[];
  sources: { id: string; label: string; kind: "bank" | "cash" | "float" | "supplier"; account: string }[];
  models: { make: string; model: string; income: string; dutyFreeIncome: string; inventory: string; cogs: string; discount: string }[];
};
export type SalesAccountingInput = {
  billingTreatment?: "dealer_paid" | "customer_billed";
  customerChargeAmount?: number;
  stage: string;
  date: string;
  amount: number;
  sourceId?: string;
  expenseType?: string;
  payerType?: string;
  reference?: string;
  notes?: string;
  invoiceId?: number;
  paymentId?: number;
  discount?: number;
  vat?: number;
  cost?: number;
  costEvidence?: string;
};
export type SalesAccountingLine = { account: string; debit: number; credit: number; purpose: string };

export const salesAccountingSettingsTable = pgTable("sales_accounting_settings", {
  dealerId: integer("dealer_id").primaryKey(),
  config: jsonb("config").$type<SalesAccountingConfigData>().notNull(),
  // The current approved rollout is preparation only; no inferred tax policy.
  vatPolicy: text("vat_policy").notNull().default("pending"),
  validation: jsonb("validation").$type<{ state: string; errors: string[]; checkedAt?: string; company?: string }>(),
  revision: integer("revision").notNull().default(1),
  updatedBy: integer("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const salesAccountingWorkflowsTable = pgTable("sales_accounting_workflows", {
  id: serial("id").primaryKey(),
  dealerId: integer("dealer_id").notNull(),
  dealId: integer("deal_id").notNull(),
  startedBy: integer("started_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("sales_accounting_workflow_deal_uq").on(t.dealerId, t.dealId)]);
export const salesAccountingEntriesTable = pgTable("sales_accounting_entries", {
  id: serial("id").primaryKey(),
  dealerId: integer("dealer_id").notNull(),
  dealId: integer("deal_id").notNull(),
  stage: text("stage").notNull(),
  input: jsonb("input").$type<SalesAccountingInput>().notNull(),
  state: text("state").notNull().default("draft"),
  lines: jsonb("lines").$type<SalesAccountingLine[]>().notNull().default([]),
  blockers: jsonb("blockers").$type<string[]>().notNull().default([]),
  revision: integer("revision").notNull().default(1),
  configRevision: integer("config_revision"),
  reviewedBy: integer("reviewed_by"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  updatedBy: integer("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("sales_accounting_entry_stage_uq").on(t.dealerId, t.dealId, t.stage)]);
