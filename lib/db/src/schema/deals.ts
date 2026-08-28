import {
  pgTable,
  serial,
  text,
  integer,
  doublePrecision,
  boolean,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { divisionsTable } from "./divisions";
import type { QuoteTaxLine } from "./quotes";

/** Canonical deal stage machine (NC-3): desking → committed → delivered (+ cancelled | lost). */
export const DEAL_STAGES = [
  "desking",
  "committed",
  "delivered",
  "cancelled",
  "lost",
] as const;
export type DealStage = (typeof DEAL_STAGES)[number];

/** Cancellation reason picklist (L9) — required when a deal/booking is cancelled. */
export const CANCELLATION_REASONS = [
  "customer_changed_mind",
  "financing_declined",
  "found_elsewhere",
  "price",
  "delivery_delay",
  "vehicle_defect",
  "duplicate",
  "other",
] as const;
export type CancellationReason = (typeof CANCELLATION_REASONS)[number];

/** Final Amount Payment Method (L6): how the balance settles. */
export const DEAL_PAYMENT_METHODS = [
  "cash",
  "bank_financing",
  "cheque",
] as const;
export type DealPaymentMethod = (typeof DEAL_PAYMENT_METHODS)[number];

export const dealsTable = pgTable("deals", {
  id: serial("id").primaryKey(),
  dealerId: integer("dealer_id").notNull(),
  divisionId: integer("division_id").references(() => divisionsTable.id),
  customerId: integer("customer_id"),
  leadId: integer("lead_id"),
  quoteId: integer("quote_id"),
  /** Database column is nullable for spec-only linked deals; most legacy
   * consumers operate only after allocation and retain the concrete type. */
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
  finalPaymentMethod: text("final_payment_method"),
  salesAdvisor: text("sales_advisor"),
  salesAdvisorUserId: integer("sales_advisor_user_id"),
  cancellationReason: text("cancellation_reason"),
  cancellationNote: text("cancellation_note"),
  /** Pricing authority copied from an approved quote, never recalculated silently. */
  dutyFreeApproved: boolean("duty_free_approved").notNull().default(false),
  taxSnapshot: jsonb("tax_snapshot").$type<QuoteTaxLine[]>(),
  cancellationGateId: integer("cancellation_gate_id"),
  /**
   * Reservation soft-lock outcome after the reservation invoice is fully
   * paid: null (no paid reservation yet), "held" (every requested unit has
   * an active reservation allocation) or "unfulfilled" (complete matching
   * stock was unavailable — payment stays recorded, staff must resolve).
   */
  reservationHoldStatus: text("reservation_hold_status"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertDealSchema = createInsertSchema(dealsTable, {
  stage: z.enum(DEAL_STAGES),
  finalPaymentMethod: z.enum(DEAL_PAYMENT_METHODS).nullable().optional(),
  cancellationReason: z.enum(CANCELLATION_REASONS).nullable().optional(),
}).omit({ dealerId: true,
  id: true,
  createdAt: true,
});
export type InsertDeal = z.infer<typeof insertDealSchema>;
export type Deal = typeof dealsTable.$inferSelect;
