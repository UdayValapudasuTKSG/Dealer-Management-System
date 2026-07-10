import {
  pgTable,
  serial,
  text,
  integer,
  doublePrecision,
  boolean,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const dealsTable = pgTable("deals", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id"),
  leadId: integer("lead_id"),
  vehicleId: integer("vehicle_id").notNull(),
  customerName: text("customer_name"),
  stage: text("stage").notNull().default("desking"),
  vehiclePrice: doublePrecision("vehicle_price").notNull(),
  discount: doublePrecision("discount").notNull().default(0),
  tradeInValue: doublePrecision("trade_in_value").notNull().default(0),
  accessories: doublePrecision("accessories").notNull().default(0),
  otdPrice: doublePrecision("otd_price").notNull().default(0),
  monthlyPayment: doublePrecision("monthly_payment"),
  depositPaid: boolean("deposit_paid").notNull().default(false),
  salesAdvisor: text("sales_advisor"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertDealSchema = createInsertSchema(dealsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertDeal = z.infer<typeof insertDealSchema>;
export type Deal = typeof dealsTable.$inferSelect;
