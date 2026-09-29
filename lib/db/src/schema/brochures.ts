import { sql } from "drizzle-orm";
import { pgTable, text, integer, boolean, timestamp, uniqueIndex, check, numeric } from "drizzle-orm/pg-core";
import { dealersTable } from "./dealers";

export const brochuresTable = pgTable("dealer_brochures", {
  id: text("id").primaryKey(),
  dealerId: integer("dealer_id").notNull().references(() => dealersTable.id),
  title: text("title").notNull(),
  fileName: text("file_name").notNull(),
  objectPath: text("object_path").notNull(),
  sha: text("sha").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  financeModel: text("finance_model"),
  downPaymentType: text("down_payment_type"),
  downPaymentValue: numeric("down_payment_value", { precision: 14, scale: 2, mode: "number" }),
  monthlyEmi: numeric("monthly_emi", { precision: 14, scale: 2, mode: "number" }),
  priceDp: numeric("price_dp", { precision: 14, scale: 2, mode: "number" }),
  priceDf: numeric("price_df", { precision: 14, scale: 2, mode: "number" }),
  financeCustomized: boolean("finance_customized").notNull().default(false),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("dealer_brochures_object_path_idx").on(t.objectPath),
  check("dealer_brochures_size_bytes_check", sql`${t.sizeBytes} > 0 AND ${t.sizeBytes} <= 20971520`),
  check("dealer_brochures_down_payment_check", sql`(${t.downPaymentType} IS NULL AND ${t.downPaymentValue} IS NULL) OR (${t.downPaymentType} IN ('amount', 'percent') AND ${t.downPaymentValue} >= 0 AND (${t.downPaymentType} <> 'percent' OR ${t.downPaymentValue} <= 100))`),
]);