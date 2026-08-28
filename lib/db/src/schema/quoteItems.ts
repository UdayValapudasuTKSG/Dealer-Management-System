import { doublePrecision, index, integer, jsonb, pgTable, serial, text, uniqueIndex } from "drizzle-orm/pg-core";
import { quotesTable, type QuoteTaxLine } from "./quotes";

/** Immutable, per-interest pricing snapshot belonging to one quote revision. */
export const quoteItemsTable = pgTable(
  "quote_items",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    quoteId: integer("quote_id").notNull().references(() => quotesTable.id, { onDelete: "cascade" }),
    vehicleId: integer("vehicle_id").notNull(),
    quantity: integer("quantity").notNull().default(1),
    position: integer("position").notNull(),
    modelYear: integer("model_year").notNull(),
    vehicleLine: text("vehicle_line").notNull(),
    trim: text("trim"),
    color: text("color"),
    manufacturer: text("manufacturer").notNull(),
    basePrice: doublePrecision("base_price").notNull(),
    taxLines: jsonb("tax_lines").$type<QuoteTaxLine[]>().notNull().default([]),
    totalTax: doublePrecision("total_tax").notNull().default(0),
    total: doublePrecision("total").notNull(),
  },
  (table) => [
    uniqueIndex("quote_items_quote_position_uq").on(table.quoteId, table.position),
    index("quote_items_dealer_quote_idx").on(table.dealerId, table.quoteId),
  ],
);
export type QuoteItem = typeof quoteItemsTable.$inferSelect;