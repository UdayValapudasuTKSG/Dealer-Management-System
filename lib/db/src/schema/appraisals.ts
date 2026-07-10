import {
  pgTable,
  serial,
  text,
  integer,
  doublePrecision,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const appraisalsTable = pgTable("appraisals", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id"),
  customerName: text("customer_name"),
  year: integer("year").notNull(),
  make: text("make").notNull(),
  model: text("model").notNull(),
  mileageKm: integer("mileage_km").notNull(),
  condition: text("condition").notNull().default("good"),
  aiEstimate: doublePrecision("ai_estimate").notNull().default(0),
  finalOffer: doublePrecision("final_offer"),
  status: text("status").notNull().default("pending"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertAppraisalSchema = createInsertSchema(appraisalsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertAppraisal = z.infer<typeof insertAppraisalSchema>;
export type Appraisal = typeof appraisalsTable.$inferSelect;
