import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { shipmentSpecsTable } from "./shipmentSpecs";

/**
 * Inbound factory shipment. ETAs are month-year keys (YYYY-MM). Baseline is
 * frozen at creation; current moves with authorised edits.
 */
export const SHIPMENT_STATUSES = [
  "open",
  "in_transit",
  "arrived",
  "closed",
  "cancelled",
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export const shipmentsTable = pgTable(
  "shipments",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    reference: text("reference").notNull(),
    status: text("status").notNull().default("open"),
    baselineEtaMonth: text("baseline_eta_month").notNull(),
    currentEtaMonth: text("current_eta_month").notNull(),
    notes: text("notes"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("shipments_dealer_reference_uq").on(t.dealerId, sql`lower(${t.reference})`),
    index("shipments_dealer_status_idx").on(t.dealerId, t.status),
    check(
      "shipments_status_ck",
      sql`${t.status} in ('open','in_transit','arrived','closed','cancelled')`,
    ),
    check(
      "shipments_eta_ck",
      sql`${t.baselineEtaMonth} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' and ${t.currentEtaMonth} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`,
    ),
  ],
);

export const shipmentLinesTable = pgTable(
  "shipment_lines",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    shipmentId: integer("shipment_id")
      .notNull()
      .references(() => shipmentsTable.id, { onDelete: "restrict" }),
    specId: integer("spec_id")
      .notNull()
      .references(() => shipmentSpecsTable.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
    importBatchId: integer("import_batch_id"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("shipment_lines_shipment_spec_uq").on(t.shipmentId, t.specId),
    index("shipment_lines_dealer_spec_idx").on(t.dealerId, t.specId),
    check("shipment_lines_qty_ck", sql`${t.quantity} > 0`),
  ],
);

/**
 * Persisted single-editor lease per shipment. A row is the lease; it is
 * valid only while expires_at is in the future. Every shipment write
 * re-checks the lease inside its transaction (UI leases alone are advisory).
 */
export const shipmentEditLocksTable = pgTable(
  "shipment_edit_locks",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    shipmentId: integer("shipment_id")
      .notNull()
      .references(() => shipmentsTable.id, { onDelete: "cascade" }),
    holderUserId: integer("holder_user_id").notNull(),
    holderName: text("holder_name").notNull(),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("shipment_edit_locks_shipment_uq").on(t.shipmentId)],
);

export type Shipment = typeof shipmentsTable.$inferSelect;
export type ShipmentLine = typeof shipmentLinesTable.$inferSelect;
export type ShipmentEditLock = typeof shipmentEditLocksTable.$inferSelect;
