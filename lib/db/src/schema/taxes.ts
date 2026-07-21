import {
  pgTable,
  serial,
  text,
  integer,
  doublePrecision,
  boolean,
  date,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { dealersTable } from "./dealers";

/**
 * Per-dealer tax rules (VAT, duty, environmental levy, registration, …).
 * Deterministic: each rule is either a percentage of the taxable base or a
 * fixed USD-scale amount, active from its effective date. Consumed by the
 * quotation engine.
 */
export const TAX_KINDS = ["percent", "fixed"] as const;
export type TaxKind = (typeof TAX_KINDS)[number];

export const dealerTaxesTable = pgTable("dealer_taxes", {
  id: serial("id").primaryKey(),
  dealerId: integer("dealer_id")
    .notNull()
    .references(() => dealersTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  code: text("code").notNull(),
  kind: text("kind").notNull().default("percent"),
  /** Percentage (0-100) when kind=percent; USD-scale amount when kind=fixed. */
  rate: doublePrecision("rate").notNull().default(0),
  /** Only applies when the taxable base exceeds this USD amount (e.g. duty threshold). */
  thresholdAmount: doublePrecision("threshold_amount"),
  /** When true, electric vehicles are exempt from this rule (configurable EV exclusion). */
  excludeEv: boolean("exclude_ev").notNull().default(false),
  effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
  active: boolean("active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  notes: text("notes"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertDealerTaxSchema = createInsertSchema(dealerTaxesTable, {
  kind: z.enum(TAX_KINDS),
  rate: z.number().min(0),
}).omit({ id: true, createdAt: true });
export type InsertDealerTax = z.infer<typeof insertDealerTaxSchema>;
export type DealerTax = typeof dealerTaxesTable.$inferSelect;

/** Guyana defaults seeded per dealer the first time the config is read. */
export const DEFAULT_DEALER_TAXES: readonly {
  code: string;
  name: string;
  kind: TaxKind;
  rate: number;
  thresholdAmount: number | null;
  excludeEv: boolean;
}[] = [
  // Guyana zero-rates electric vehicles for VAT, duty and excise — hence the
  // configurable EV exclusion default on those rules.
  { code: "vat", name: "VAT", kind: "percent", rate: 14, thresholdAmount: null, excludeEv: true },
  { code: "import_duty", name: "Import Duty", kind: "percent", rate: 45, thresholdAmount: 30000, excludeEv: true },
  { code: "excise", name: "Excise Tax", kind: "percent", rate: 10, thresholdAmount: null, excludeEv: true },
  { code: "environmental", name: "Environmental Levy", kind: "fixed", rate: 25, thresholdAmount: null, excludeEv: false },
  { code: "registration", name: "Registration Fee", kind: "fixed", rate: 75, thresholdAmount: null, excludeEv: false },
] as const;
