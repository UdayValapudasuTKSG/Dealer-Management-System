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

export const serviceOrdersTable = pgTable("service_orders", {
  id: serial("id").primaryKey(),
  dealerId: integer("dealer_id").notNull(),
  customerId: integer("customer_id"),
  customerName: text("customer_name"),
  vehicleInfo: text("vehicle_info").notNull(),
  type: text("type").notNull().default("maintenance"),
  status: text("status").notNull().default("scheduled"),
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
).omit({ dealerId: true, id: true, createdAt: true });
export type InsertServiceOrder = z.infer<typeof insertServiceOrderSchema>;
export type ServiceOrder = typeof serviceOrdersTable.$inferSelect;
