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
import { shipmentsTable } from "./shipments";
import { shipmentSpecsTable } from "./shipmentSpecs";
import { shipmentAllocationsTable } from "./shipmentAllocations";

/** Import batch (lines or manifest). Retried identical files replay. */
export const shipmentImportBatchesTable = pgTable(
  "shipment_import_batches",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    shipmentId: integer("shipment_id")
      .notNull()
      .references(() => shipmentsTable.id, { onDelete: "restrict" }),
    kind: text("kind").notNull(),
    fileName: text("file_name").notNull(),
    fileHash: text("file_hash").notNull(),
    totalRows: integer("total_rows").notNull(),
    acceptedRows: integer("accepted_rows").notNull(),
    rejectedRows: integer("rejected_rows").notNull(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("shipment_import_batches_hash_uq").on(t.dealerId, t.shipmentId, t.kind, t.fileHash),
    check("shipment_import_batches_kind_ck", sql`${t.kind} in ('lines','manifest')`),
  ],
);

export const shipmentImportRowErrorsTable = pgTable(
  "shipment_import_row_errors",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    batchId: integer("batch_id")
      .notNull()
      .references(() => shipmentImportBatchesTable.id, { onDelete: "cascade" }),
    rowNumber: integer("row_number").notNull(),
    message: text("message").notNull(),
    rawRow: text("raw_row").notNull(),
  },
  (t) => [index("shipment_import_row_errors_batch_idx").on(t.batchId, t.rowNumber)],
);

/** Real factory VIN on a shipment manifest. One per dealer VIN. */
export const SHIPMENT_MANIFEST_STATUSES = ["unmatched", "proposed", "confirmed"] as const;

export const shipmentManifestsTable = pgTable(
  "shipment_manifests",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    shipmentId: integer("shipment_id")
      .notNull()
      .references(() => shipmentsTable.id, { onDelete: "restrict" }),
    specId: integer("spec_id")
      .notNull()
      .references(() => shipmentSpecsTable.id, { onDelete: "restrict" }),
    vin: text("vin").notNull(),
    status: text("status").notNull().default("unmatched"),
    importBatchId: integer("import_batch_id"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("shipment_manifests_dealer_vin_uq").on(t.dealerId, t.vin),
    index("shipment_manifests_shipment_idx").on(t.shipmentId, t.specId),
    check("shipment_manifests_vin_ck", sql`${t.vin} ~ '^[A-HJ-NPR-Z0-9]{17}$'`),
    check(
      "shipment_manifests_status_ck",
      sql`${t.status} in ('unmatched','proposed','confirmed')`,
    ),
  ],
);

export const shipmentMatchRunsTable = pgTable(
  "shipment_match_runs",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    shipmentId: integer("shipment_id")
      .notNull()
      .references(() => shipmentsTable.id, { onDelete: "restrict" }),
    proposedCount: integer("proposed_count").notNull(),
    shortageUnits: integer("shortage_units").notNull(),
    unmatchedVins: integer("unmatched_vins").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("shipment_match_runs_shipment_idx").on(t.dealerId, t.shipmentId)],
);

/**
 * Immutable proposal: (manifest VIN -> allocation). Only status transitions
 * pending -> confirmed | superseded | rejected. Confirmation binds through
 * the existing reservation-allocation claim ledger only.
 */
export const shipmentMatchProposalsTable = pgTable(
  "shipment_match_proposals",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    shipmentId: integer("shipment_id").notNull(),
    runId: integer("run_id")
      .notNull()
      .references(() => shipmentMatchRunsTable.id, { onDelete: "restrict" }),
    manifestId: integer("manifest_id")
      .notNull()
      .references(() => shipmentManifestsTable.id, { onDelete: "restrict" }),
    allocationId: integer("allocation_id")
      .notNull()
      .references(() => shipmentAllocationsTable.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("pending"),
    lastBlockedReason: text("last_blocked_reason"),
    interiorVerified: boolean("interior_verified").notNull().default(false),
    reservationAllocationId: integer("reservation_allocation_id"),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("shipment_match_proposals_manifest_live_uq")
      .on(t.manifestId)
      .where(sql`${t.status} in ('pending','confirmed')`),
    index("shipment_match_proposals_alloc_idx").on(t.allocationId, t.status),
    check(
      "shipment_match_proposals_status_ck",
      sql`${t.status} in ('pending','confirmed','superseded','rejected')`,
    ),
  ],
);

export type ShipmentImportBatch = typeof shipmentImportBatchesTable.$inferSelect;
export type ShipmentManifest = typeof shipmentManifestsTable.$inferSelect;
export type ShipmentMatchProposal = typeof shipmentMatchProposalsTable.$inferSelect;
export type ShipmentMatchRun = typeof shipmentMatchRunsTable.$inferSelect;
