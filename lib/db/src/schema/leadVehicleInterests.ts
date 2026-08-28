import { index, integer, pgTable, serial, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { leadsTable } from "./leads";

/** A dealer-scoped vehicle/model interest. The first position is the legacy primary interest. */
export const leadVehicleInterestsTable = pgTable(
  "lead_vehicle_interests",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    leadId: integer("lead_id").notNull().references(() => leadsTable.id, { onDelete: "cascade" }),
    vehicleId: integer("vehicle_id").notNull(),
    quantity: integer("quantity").notNull().default(1),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("lead_vehicle_interests_lead_vehicle_uq").on(table.leadId, table.vehicleId),
    uniqueIndex("lead_vehicle_interests_lead_position_uq").on(table.leadId, table.position),
    index("lead_vehicle_interests_dealer_lead_idx").on(table.dealerId, table.leadId),
  ],
);
export type LeadVehicleInterest = typeof leadVehicleInterestsTable.$inferSelect;