import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { shipmentLinesTable, shipmentsTable } from "./shipments";
import { shipmentSpecsTable } from "./shipmentSpecs";

/**
 * Quantity allocation of shipment-line capacity to a real eligible lead
 * (optionally its deal). Fulfilment status is separate from sales stages.
 *  - active: Vehicle Allocated (capacity consumed exactly once at insert)
 *  - fulfilled: every unit has a confirmed VIN claim
 *  - released: capacity returned
 *  - reassigned: moved to another line (successor keeps baseline_at)
 */
export const SHIPMENT_ALLOCATION_STATUSES = [
  "active",
  "fulfilled",
  "released",
  "reassigned",
] as const;
export type ShipmentAllocationStatus = (typeof SHIPMENT_ALLOCATION_STATUSES)[number];

export const shipmentAllocationsTable = pgTable(
  "shipment_allocations",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    shipmentId: integer("shipment_id")
      .notNull()
      .references(() => shipmentsTable.id, { onDelete: "restrict" }),
    shipmentLineId: integer("shipment_line_id")
      .notNull()
      .references(() => shipmentLinesTable.id, { onDelete: "restrict" }),
    specId: integer("spec_id")
      .notNull()
      .references(() => shipmentSpecsTable.id, { onDelete: "restrict" }),
    leadId: integer("lead_id").notNull(),
    dealId: integer("deal_id"),
    requestedQuantity: integer("requested_quantity").notNull(),
    quantity: integer("quantity").notNull(),
    partialConsent: boolean("partial_consent").notNull().default(false),
    status: text("status").notNull().default("active"),
    /** Priority timestamp. Preserved across reassignment. */
    baselineAt: timestamp("baseline_at", { withTimezone: true }).notNull(),
    baselineEtaMonth: text("baseline_eta_month").notNull(),
    specsConfirmedBy: text("specs_confirmed_by").notNull(),
    reassignedFromId: integer("reassigned_from_id"),
    releasedReason: text("released_reason"),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("shipment_allocations_lead_spec_active_uq")
      .on(t.dealerId, t.leadId, t.specId)
      .where(sql`${t.status} = 'active'`),
    uniqueIndex("shipment_allocations_reassigned_from_uq")
      .on(t.reassignedFromId)
      .where(sql`${t.reassignedFromId} is not null`),
    index("shipment_allocations_line_idx").on(t.shipmentLineId, t.status),
    index("shipment_allocations_dealer_lead_idx").on(t.dealerId, t.leadId),
    check(
      "shipment_allocations_status_ck",
      sql`${t.status} in ('active','fulfilled','released','reassigned')`,
    ),
    check(
      "shipment_allocations_qty_ck",
      sql`${t.quantity} > 0 and ${t.quantity} <= ${t.requestedQuantity} and (${t.quantity} = ${t.requestedQuantity} or ${t.partialConsent})`,
    ),
  ],
);

/**
 * Event outbox + audit trail for shipments. Append-only.
 */
export const shipmentEventsTable = pgTable(
  "shipment_events",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    shipmentId: integer("shipment_id"),
    allocationId: integer("allocation_id"),
    kind: text("kind").notNull(),
    detail: text("detail").notNull(),
    actor: text("actor").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("shipment_events_dealer_shipment_idx").on(t.dealerId, t.shipmentId, t.createdAt),
  ],
);

/**
 * Customer email outbox. Sending is disabled pending template rollout
 * approval, so jobs are recorded with an honest withheld/suppressed state.
 */
export const SHIPMENT_EMAIL_STATUSES = [
  "queued",
  "withheld",
  "suppressed",
  "superseded",
  "sent",
  "failed",
] as const;
export type ShipmentEmailStatus = (typeof SHIPMENT_EMAIL_STATUSES)[number];

export const shipmentEmailJobsTable = pgTable(
  "shipment_email_jobs",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    shipmentId: integer("shipment_id").notNull(),
    allocationId: integer("allocation_id").notNull(),
    kind: text("kind").notNull(),
    etaMonth: text("eta_month").notNull(),
    status: text("status").notNull(),
    reason: text("reason").notNull(),
    supersededById: integer("superseded_by_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("shipment_email_jobs_alloc_idx").on(t.dealerId, t.allocationId),
    check("shipment_email_jobs_kind_ck", sql`${t.kind} in ('initial','eta_change')`),
    check(
      "shipment_email_jobs_status_ck",
      sql`${t.status} in ('queued','withheld','suppressed','superseded','sent','failed')`,
    ),
  ],
);

export type ShipmentAllocation = typeof shipmentAllocationsTable.$inferSelect;
export type ShipmentEvent = typeof shipmentEventsTable.$inferSelect;
export type ShipmentEmailJob = typeof shipmentEmailJobsTable.$inferSelect;
