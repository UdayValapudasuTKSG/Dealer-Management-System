import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";
import { customersTable } from "./customers";

// Lifetime ownership record: a delivered vehicle becomes an Asset on the
// account. One row per handover — a re-sold vehicle gets a new row on the new
// account and the old row is marked transferred.
export const assetsTable = pgTable("assets", {
  id: serial("id").primaryKey(),
  dealerId: integer("dealer_id").notNull(),
  accountId: integer("account_id")
    .notNull()
    .references(() => customersTable.id, { onDelete: "cascade" }),
  vehicleId: integer("vehicle_id").notNull(),
  dealId: integer("deal_id"),
  deliveryId: integer("delivery_id"),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }).notNull(),
  serviceAdvisorUserId: integer("service_advisor_user_id"),
  status: text("status").notNull().default("active"), // active | transferred
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Asset = typeof assetsTable.$inferSelect;
