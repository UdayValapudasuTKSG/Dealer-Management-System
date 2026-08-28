import { doublePrecision, index, integer, jsonb, pgTable, serial, text, uniqueIndex } from "drizzle-orm/pg-core";
import { dealsTable } from "./deals";
import type { QuoteTaxLine } from "./quotes";

/** The individual vehicle commitments that make up a deal. */
export const dealItemsTable = pgTable(
  "deal_items",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    dealId: integer("deal_id").notNull().references(() => dealsTable.id, { onDelete: "cascade" }),
    quoteItemId: integer("quote_item_id"),
    vehicleId: integer("vehicle_id").notNull(),
    quantity: integer("quantity").notNull().default(1),
    position: integer("position").notNull(),
    vehiclePrice: doublePrecision("vehicle_price").notNull(),
    discount: doublePrecision("discount").notNull().default(0),
    taxSnapshot: jsonb("tax_snapshot").$type<QuoteTaxLine[]>().notNull().default([]),
    total: doublePrecision("total").notNull(),
    status: text("status").notNull().default("open"),
  },
  (table) => [
    uniqueIndex("deal_items_deal_position_uq").on(table.dealId, table.position),
    index("deal_items_dealer_deal_idx").on(table.dealerId, table.dealId),
  ],
);
export type DealItem = typeof dealItemsTable.$inferSelect;