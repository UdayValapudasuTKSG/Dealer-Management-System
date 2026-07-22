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
