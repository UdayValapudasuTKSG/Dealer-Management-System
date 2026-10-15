import { pgTable, integer, serial, text, timestamp, jsonb, uniqueIndex, index, bigint } from "drizzle-orm/pg-core";

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

/** Operational sales-finance request: one immutable submission per business
 * event (many per deal). Amounts are integer cents. Posting state is distinct
 * from approval state; `posted` only after confirmed ERPNext success. */
export type SalesFinanceRequestSnapshot = {
  input: Record<string, unknown>;
  lines: SalesAccountingLine[];
  configRevision: number;
  source?: { id: string; label: string; kind: string; account: string } | null;
  chargeRule?: { category: string; incomeAccount: string; taxTreatment: string; vatRate: number; amountIncludesVat: boolean; approvalReference: string } | null;
  accounts: Record<string, string>;
  invoice?: { id: number; invoiceNumber: string; kind: string; amountCents: number;
    /** Immutable approval basis, re-verified under row lock before posting. */
    taxCents?: number; customerId?: number | null; customerName?: string; currency?: string } | null;
};
export const salesFinanceRequestsTable = pgTable("sales_finance_requests", {
  id: serial("id").primaryKey(),
  dealerId: integer("dealer_id").notNull(),
  dealId: integer("deal_id").notNull(),
  invoiceId: integer("invoice_id"),
  kind: text("kind").notNull(),
  category: text("category"),
  date: text("date").notNull(),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  paymentMethod: text("payment_method"),
  sourceId: text("source_id"),
  payerType: text("payer_type"),
  reference: text("reference").notNull(),
  evidence: text("evidence"),
  billingTreatment: text("billing_treatment"),
  customerChargeCents: bigint("customer_charge_cents", { mode: "number" }),
  legacyPaymentId: integer("legacy_payment_id"),
  snapshot: jsonb("snapshot").$type<SalesFinanceRequestSnapshot>().notNull(),
  configRevision: integer("config_revision").notNull(),
  blockers: jsonb("blockers").$type<string[]>().notNull().default([]),
  status: text("status").notNull().default("pending"),
  requestedBy: integer("requested_by").notNull(),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  reviewedBy: integer("reviewed_by"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  rejectionReason: text("rejection_reason"),
  paymentId: integer("payment_id"),
  chargeInvoiceId: integer("charge_invoice_id"),
  erpJobId: integer("erp_job_id"),
  erpDoctype: text("erp_doctype"),
  erpDocName: text("erp_doc_name"),
  erpRemoteKey: text("erp_remote_key"),
  postAttempts: integer("post_attempts").notNull().default(0),
  lastError: text("last_error"),
  postedAt: timestamp("posted_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index("sales_finance_requests_deal_idx").on(t.dealerId, t.dealId),
  index("sales_finance_requests_status_idx").on(t.dealerId, t.status),
  uniqueIndex("sales_finance_requests_payment_uq").on(t.paymentId),
  uniqueIndex("sales_finance_requests_charge_invoice_uq").on(t.chargeInvoiceId),
]);
export type SalesFinanceRequest = typeof salesFinanceRequestsTable.$inferSelect;
