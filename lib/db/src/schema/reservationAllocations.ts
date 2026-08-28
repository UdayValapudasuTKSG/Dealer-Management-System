import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { dealsTable } from "./deals";
import { dealItemsTable } from "./dealItems";

/**
 * Reservation soft-lock lifecycle:
 *  - active: the vehicle is temporarily held for the paid reservation.
 *  - finalized: deal commitment adopted the hold into a delivery allocation.
 *  - released: cancellation / refund / expiry / lead closure freed the unit.
 */
export const RESERVATION_ALLOCATION_STATUSES = [
  "active",
  "finalized",
  "released",
] as const;
export type ReservationAllocationStatus =
  (typeof RESERVATION_ALLOCATION_STATUSES)[number];

/**
 * One row per physical unit soft-locked by a fully paid reservation invoice.
 * Allocation is all-or-nothing per deal: either every deal-item unit has an
 * active row, or none do (payment stays recorded; the deal is flagged for
 * inventory resolution instead).
 */
export const reservationAllocationsTable = pgTable(
  "reservation_allocations",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    dealId: integer("deal_id")
      .notNull()
      .references(() => dealsTable.id, { onDelete: "cascade" }),
    invoiceId: integer("invoice_id"),
    dealItemId: integer("deal_item_id")
      .notNull()
      .references(() => dealItemsTable.id, { onDelete: "cascade" }),
    /** Zero-based physical unit within deal_items.quantity. */
    dealItemUnit: integer("deal_item_unit").notNull(),
    vehicleId: integer("vehicle_id").notNull(),
    status: text("status").notNull().default("active"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    releasedReason: text("released_reason"),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // One active hold per deal-item unit …
    uniqueIndex("reservation_allocations_item_unit_active_uq")
      .on(table.dealItemId, table.dealItemUnit)
      .where(sql`${table.status} = 'active'`),
    // … and one active hold per physical vehicle.
    uniqueIndex("reservation_allocations_vehicle_active_uq")
      .on(table.vehicleId)
      .where(sql`${table.status} = 'active'`),
    index("reservation_allocations_dealer_deal_idx").on(
      table.dealerId,
      table.dealId,
    ),
  ],
);

export type ReservationAllocation =
  typeof reservationAllocationsTable.$inferSelect;
