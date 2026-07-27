import {
  pgTable,
  serial,
  text,
  integer,
  doublePrecision,
  date,
  timestamp,
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

export const serviceOrdersTable = pgTable("service_orders", {
  id: serial("id").primaryKey(),
  dealerId: integer("dealer_id").notNull(),
  customerId: integer("customer_id"),
  customerName: text("customer_name"),
  vehicleInfo: text("vehicle_info").notNull(),
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
