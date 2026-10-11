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

/**
 * Manager-maintained, dealer-scoped exact specification catalogue for
 * shipment allocation. Every attribute is required; "N/A" is an explicit
 * value, never a wildcard. Only `approved` specs may be used on shipment
 * lines, allocations or manifests.
 */
export const SHIPMENT_SPEC_STATUSES = ["draft", "approved", "retired"] as const;
export type ShipmentSpecStatus = (typeof SHIPMENT_SPEC_STATUSES)[number];

export const shipmentSpecsTable = pgTable(
  "shipment_specs",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    make: text("make").notNull(),
    model: text("model").notNull(),
    year: integer("year").notNull(),
    variant: text("variant").notNull(),
    exteriorColor: text("exterior_color").notNull(),
    interiorColor: text("interior_color").notNull(),
    /** Normalised lower-case key of the six attributes for exact uniqueness. */
    specKey: text("spec_key").notNull(),
    status: text("status").notNull().default("draft"),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("shipment_specs_dealer_key_uq").on(t.dealerId, t.specKey),
    index("shipment_specs_dealer_status_idx").on(t.dealerId, t.status),
    check("shipment_specs_status_ck", sql`${t.status} in ('draft','approved','retired')`),
    check(
      "shipment_specs_nonblank_ck",
      sql`btrim(${t.make}) <> '' and btrim(${t.model}) <> '' and btrim(${t.variant}) <> '' and btrim(${t.exteriorColor}) <> '' and btrim(${t.interiorColor}) <> ''`,
    ),
  ],
);

export type ShipmentSpec = typeof shipmentSpecsTable.$inferSelect;
