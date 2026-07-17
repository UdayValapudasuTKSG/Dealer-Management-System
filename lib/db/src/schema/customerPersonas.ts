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
import { customersTable } from "./customers";

export const customerPersonasTable = pgTable("customer_personas", {
  id: serial("id").primaryKey(),
  dealerId: integer("dealer_id").notNull(),
  customerId: integer("customer_id")
    .notNull()
    .unique()
    .references(() => customersTable.id, { onDelete: "cascade" }),
  ageGroup: text("age_group"),
  incomeRange: text("income_range"),
  buyingBudget: doublePrecision("buying_budget"),
  familySize: integer("family_size"),
  vehiclePreference: text("vehicle_preference"),
  brandPreference: text("brand_preference"),
  fuelPreference: text("fuel_preference"),
  drivingHabits: text("driving_habits"),
  purchaseMotivation: text("purchase_motivation"),
  lifestyle: text("lifestyle"),
  buyingProbability: text("buying_probability"),
  financeRequired: boolean("finance_required"),
  tradeIn: boolean("trade_in"),
  previousPurchases: integer("previous_purchases"),
  communicationPreference: text("communication_preference"),
  marketingConsent: boolean("marketing_consent"),
  aiRecommendedVehicleId: integer("ai_recommended_vehicle_id"),
  aiRecommendationReason: text("ai_recommendation_reason"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertCustomerPersonaSchema = createInsertSchema(
  customerPersonasTable,
  {
    ageGroup: z
      .enum(["18-24", "25-34", "35-44", "45-54", "55-64", "65+"])
      .nullable()
      .optional(),
    buyingProbability: z
      .enum(["low", "medium", "high", "very_high"])
      .nullable()
      .optional(),
    communicationPreference: z
      .enum(["email", "phone", "whatsapp", "sms", "in_person"])
      .nullable()
      .optional(),
  },
).omit({ dealerId: true, id: true, updatedAt: true });
export type InsertCustomerPersona = z.infer<typeof insertCustomerPersonaSchema>;
export type CustomerPersona = typeof customerPersonasTable.$inferSelect;
