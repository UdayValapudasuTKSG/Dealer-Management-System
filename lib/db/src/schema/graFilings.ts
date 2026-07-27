import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  doublePrecision,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";

export type GraFilingTaxLine = {
  code: string;
  name: string;
  kind: "percent" | "fixed";
  rate: number;
  amount: number;
  /** Human-readable basis the line was computed on (e.g. "CIF value", "CIF + duty + excise"). */
  basis?: string;
  /** USD-scale base amount the rate was applied to (null for fixed lines). */
  baseAmount?: number | null;
};

/** Snapshot of the GRA rule path used to compute this filing's duty. */
export type GraFilingBreakdown = {
  ageCategory: "under_4" | "four_plus";
  ccBand: string;
  importerType: string;
  exciseBaseUsd: number | null;
  formulaPath: string;
  exemptionApplied: string | null;
  dutyRatePct: number;
  exciseRatePct: number | null;
  vatRatePct: number;
};

/**
 * Immutable GRA (Guyana Revenue Authority) duty filing snapshot. Created in
 * "pending_gate" state when the officer submits a draft (which raises the
 * gra_filing decision gate) and flipped to "filed" ONLY when a human resolves
 * that gate. All monetary amounts are USD-scale; the dealer's usdExchangeRate
 * is snapshotted at submit time so later rate drift never retro-changes a
 * filed duty. Tax lines are server-computed from dealer_taxes — never client
 * or AI supplied.
 */
export const graFilingsTable = pgTable("gra_filings", {
  id: serial("id").primaryKey(),
  dealerId: integer("dealer_id").notNull(),
  gateId: integer("gate_id").notNull(),
  vehicleId: integer("vehicle_id"),
  // Deal this filing clears customs for — the transaction-level tag so the
  // duty pack travels with the deal, not just the unit.
  dealId: integer("deal_id"),
  filingRef: text("filing_ref").notNull(),
  status: text("status").notNull().default("pending_gate"), // pending_gate | filed | rejected
  ownerName: text("owner_name").notNull(),
  tin: text("tin").notNull(),
  vin: text("vin").notNull(),
  make: text("make").notNull(),
  model: text("model").notNull(),
  year: integer("year").notNull(),
  engineCc: integer("engine_cc").notNull(),
  fuelType: text("fuel_type").notNull(),
  hsCode: text("hs_code").notNull(),
  cifValue: doublePrecision("cif_value").notNull(),
  // CIF composition (17-mB step 3): FOB + freight + insurance = CIF. Nullable —
  // when all three are supplied they must sum to cifValue (422 otherwise).
  fobValue: doublePrecision("fob_value"),
  freightValue: doublePrecision("freight_value"),
  insuranceValue: doublePrecision("insurance_value"),
  // Traceability (R8.7): which uploaded documents each figure came from, and
  // the per-field AI extraction confidence (human-confirmed at the gate).
  sourceDocIds: jsonb("source_doc_ids").$type<number[] | null>(),
  fieldConfidence: jsonb("field_confidence").$type<Record<string, number> | null>(),
  // Real-GRA-rules inputs (nullable so legacy rows still serialize).
  importerType: text("importer_type"), // private | dealer_used | new_vehicle_trader
  bodyType: text("body_type"),
  isHybrid: boolean("is_hybrid"),
  yearOfImport: integer("year_of_import"),
  retailPrice: doublePrecision("retail_price"),
  breakdown: jsonb("breakdown").$type<GraFilingBreakdown | null>(),
  reviewFlags: jsonb("review_flags").$type<string[] | null>(),
  exchangeRate: doublePrecision("exchange_rate").notNull(),
  evExcluded: boolean("ev_excluded").notNull().default(false),
  taxLines: jsonb("tax_lines").$type<GraFilingTaxLine[]>().notNull().default([]),
  totalPayable: doublePrecision("total_payable").notNull(),
  sourceNotes: text("source_notes"),
  filedBy: text("filed_by"),
  filedAt: timestamp("filed_at", { withTimezone: true }),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type GraFiling = typeof graFilingsTable.$inferSelect;
export type NewGraFiling = typeof graFilingsTable.$inferInsert;
