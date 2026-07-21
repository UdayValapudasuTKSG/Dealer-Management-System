import {
  pgTable,
  serial,
  text,
  integer,
  doublePrecision,
  boolean,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { leadsTable } from "./leads";

/**
 * Quotation "Codes" — the GT-format estimate documents auto-generated for
 * every lead (Agent A3). Numbering is sequential per dealer; each regeneration
 * creates a new version row (prior versions are retained, never deleted).
 * All money is USD-scale per the currency convention.
 */
export const QUOTE_STATUSES = ["current", "superseded"] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export type QuoteTaxLine = {
  code: string;
  name: string;
  kind: "percent" | "fixed";
  rate: number;
  amount: number;
};

export const quotesTable = pgTable("quotes", {
  id: serial("id").primaryKey(),
  dealerId: integer("dealer_id").notNull(),
  leadId: integer("lead_id")
    .notNull()
    .references(() => leadsTable.id, { onDelete: "cascade" }),
  vehicleId: integer("vehicle_id"),
  /** Sequential per-dealer estimate number, e.g. EST-00042 (stable across versions). */
  quoteNumber: text("quote_number").notNull(),
  version: integer("version").notNull().default(1),
  status: text("status").notNull().default("current"),
  // GT exact-format fields, frozen at generation time.
  customerName: text("customer_name").notNull(),
  customerAddress: text("customer_address"),
  modelYear: integer("model_year").notNull(),
  vehicleLine: text("vehicle_line").notNull(),
  trim: text("trim"),
  color: text("color"),
  manufacturer: text("manufacturer").notNull(),
  mfgDate: text("mfg_date"),
  quantity: integer("quantity").notNull().default(1),
  // Deterministic pricing snapshot (USD-scale).
  basePrice: doublePrecision("base_price").notNull(),
  taxLines: jsonb("tax_lines").$type<QuoteTaxLine[]>().notNull().default([]),
  totalTax: doublePrecision("total_tax").notNull().default(0),
  total: doublePrecision("total").notNull(),
  issuedOn: text("issued_on").notNull(),
  validUntil: text("valid_until").notNull(),
  /** What caused this version: lead_created | lead_updated | manual. */
  trigger: text("trigger").notNull().default("manual"),
  createdBy: text("created_by").notNull(),
  isAgent: boolean("is_agent").notNull().default(false),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  sentVia: text("sent_via"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertQuoteSchema = createInsertSchema(quotesTable).omit({
  dealerId: true,
  id: true,
  createdAt: true,
});
export type InsertQuote = z.infer<typeof insertQuoteSchema>;
export type Quote = typeof quotesTable.$inferSelect;
