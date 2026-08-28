import { integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/** Dealer-wide quote-number registry. One identity is shared by all revisions of one lead. */
export const quoteNumbersTable = pgTable(
  "quote_numbers",
  {
    dealerId: integer("dealer_id").notNull(),
    quoteNumber: text("quote_number").notNull(),
    leadId: integer("lead_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("quote_numbers_dealer_number_uq").on(table.dealerId, table.quoteNumber),
    uniqueIndex("quote_numbers_dealer_lead_uq").on(table.dealerId, table.leadId),
    uniqueIndex("quote_numbers_owner_tuple_uq").on(
      table.dealerId,
      table.quoteNumber,
      table.leadId,
    ),
  ],
);