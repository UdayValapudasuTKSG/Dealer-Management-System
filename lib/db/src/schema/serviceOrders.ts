import {
  pgTable,
  serial,
  text,
  integer,
  doublePrecision,
  date,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Canonical service-order (Case) machine (NC-3):
 * open → acknowledged → in_progress → on_hold → resolved → closed (+ cancelled).
 */
export const SERVICE_ORDER_STATUSES = [
  "open",
  "acknowledged",
  "in_progress",
  "on_hold",
  "resolved",
  "closed",
  "cancelled",
] as const;
export type ServiceOrderStatus = (typeof SERVICE_ORDER_STATUSES)[number];

/** Case intake types (L11/L12): scheduled cadence vs unscheduled triage. */
export const SERVICE_ORDER_TYPES = [
  "maintenance",
  "repair",
  "warranty",
  "recall",
  "inspection",
  "comeback",
  "unscheduled",
] as const;
export type ServiceOrderType = (typeof SERVICE_ORDER_TYPES)[number];

/** Who pays (L11): warranty claim, customer, goodwill, or rectify (comeback). */
export const SERVICE_PAY_TYPES = [
  "customer",
  "warranty",
  "goodwill",
  "rectify",
] as const;
export type ServicePayType = (typeof SERVICE_PAY_TYPES)[number];

/** One audited entry per stage transition; justification is mandatory. */
export type ServiceStageEvent = {
  from: string;
  to: string;
  justification: string;
  byUserId: number | null;
  byName: string;
  at: string;
};

export const serviceOrdersTable = pgTable("service_orders", {
  id: serial("id").primaryKey(),
  dealerId: integer("dealer_id").notNull(),
  customerId: integer("customer_id"),
  customerName: text("customer_name"),
  customerPhoneSnapshot: text("customer_phone_snapshot"),
  vehicleInfo: text("vehicle_info").notNull(),
  /** Canonical selected vehicle make used to resolve dealer labour pricing. */
  brand: text("brand"),
  vin: text("vin"),
  registrationNumber: text("registration_number"),
  vehicleId: integer("vehicle_id"),
  assetId: integer("asset_id"),
  type: text("type").notNull().default("maintenance"),
  payType: text("pay_type").notNull().default("customer"),
  status: text("status").notNull().default("open"),
  scheduledDate: date("scheduled_date", { mode: "string" }).notNull(),
  complaint: text("complaint"),
  odometer: integer("odometer"),
  technician: text("technician"),
  technicianUserId: integer("technician_user_id"),
  estimatedCost: doublePrecision("estimated_cost").notNull().default(0),
  /** Booked technician hours for capacity planning (default from dealer settings). */
  estimatedHours: doublePrecision("estimated_hours").notNull().default(2),
  /** Append-only stage-transition audit trail with mandatory justifications. */
  stageHistory: jsonb("stage_history")
    .$type<ServiceStageEvent[]>()
    .notNull()
    .default([]),
  /** Immutable booking provenance. Null means this pre-dates provenance capture,
   * not that a current actor was hidden. */
  createdByUserId: integer("created_by_user_id"),
  createdByName: text("created_by_name"),
  createdOrigin: text("created_origin").notNull().default("system"),
  jobs: text("jobs").array().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertServiceOrderSchema = createInsertSchema(
  serviceOrdersTable,
  {
    status: z.enum(SERVICE_ORDER_STATUSES),
    type: z.enum(SERVICE_ORDER_TYPES),
    payType: z.enum(SERVICE_PAY_TYPES),
  },
).omit({ dealerId: true, id: true, createdAt: true });
export type InsertServiceOrder = z.infer<typeof insertServiceOrderSchema>;
export type ServiceOrder = typeof serviceOrdersTable.$inferSelect;
