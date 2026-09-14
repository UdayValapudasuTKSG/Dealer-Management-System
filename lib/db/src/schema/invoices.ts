import {
  pgTable,
  serial,
  text,
  integer,
  doublePrecision,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const INVOICE_STATUSES = [
  "issued",
  "partially_paid",
  "paid",
  "void",
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/** Dual-invoice model (L6): reservation fee invoice + final settlement invoice. */
export const INVOICE_KINDS = ["reservation", "final"] as const;
export type InvoiceKind = (typeof INVOICE_KINDS)[number];

export type InvoiceTaxLine = {
  code: string;
  name: string;
  kind: "percent" | "fixed";
  rate: number;
  amount: number;
};

export const invoicesTable = pgTable("invoices", {
  id: serial("id").primaryKey(),
  dealerId: integer("dealer_id").notNull(),
  invoiceNumber: text("invoice_number").notNull(),
  customerId: integer("customer_id"),
  customerName: text("customer_name").notNull(),
  dealId: integer("deal_id"),
  applicationId: integer("application_id"),
  description: text("description"),
  amount: doublePrecision("amount").notNull(),
  kind: text("kind").notNull().default("final"),
  status: text("status").notNull().default("issued"),
  dueDate: text("due_date"),
  /** Deterministic dealer_taxes snapshot computed when the invoice was issued. */
  taxLines: jsonb("tax_lines").$type<InvoiceTaxLine[]>().notNull().default([]),
  /** Amounts are USD-scale; GYD display uses the snapshot exchange rate. */
  currency: text("currency").notNull().default("GYD"),
  exchangeRate: doublePrecision("exchange_rate"),
  /** Import provenance, including durable customer-communications suppression. */
  importMetadata: jsonb("import_metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertInvoiceSchema = createInsertSchema(invoicesTable, {
  status: z.enum(INVOICE_STATUSES),
  kind: z.enum(INVOICE_KINDS),
}).omit({ dealerId: true, id: true, createdAt: true, invoiceNumber: true });
export type InsertInvoice = z.infer<typeof insertInvoiceSchema>;
export type Invoice = typeof invoicesTable.$inferSelect;
