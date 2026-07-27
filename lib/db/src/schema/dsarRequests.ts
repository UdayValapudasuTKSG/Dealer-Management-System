import {
  pgTable,
  serial,
  text,
  integer,
  jsonb,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

/** R10.4 data-subject request kinds. */
export const DSAR_KINDS = ["export", "erase"] as const;
export type DsarKind = (typeof DSAR_KINDS)[number];

/** Async DSR lifecycle (NC-1: both export and erase are 202-accepted). */
export const DSAR_STATUSES = [
  "processing",
  "completed",
  "failed",
  "blocked", // legal hold — queued for post-hold execution (R10.5)
] as const;
export type DsarStatus = (typeof DSAR_STATUSES)[number];

/** Per-step saga marker (NC-11): each erasure step records completion. */
export interface DsarStepMarker {
  step: string;
  completedAt: string;
  detail?: string;
}

/**
 * R10.4/R10.5 — data-subject requests (export & erasure) run as durable
 * async operations with per-step markers. Erasure spans DB + GCS, so it is
 * a saga: never a single transaction across external stores.
 */
export const dsarRequestsTable = pgTable(
  "dsar_requests",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    customerId: integer("customer_id").notNull(),
    kind: text("kind").$type<DsarKind>().notNull(),
    status: text("status").$type<DsarStatus>().notNull().default("processing"),
    requestedBy: text("requested_by").notNull(),
    // Export: the assembled portable bundle (C1–C5 within dealer scope).
    bundle: jsonb("bundle").$type<Record<string, unknown>>(),
    // Erasure saga step markers (idempotent re-entry).
    steps: jsonb("steps").$type<DsarStepMarker[]>().notNull().default([]),
    // Legal holds blocking erasure (422 unmet[]) — kept for the queued retry.
    unmet: jsonb("unmet").$type<string[]>(),
    // R10.7 PENDING-INFRA: durable marker that backups/DR still hold the
    // subject's data; consumed when crypto-shred/backup tooling lands.
    pendingBackupErasure: boolean("pending_backup_erasure")
      .notNull()
      .default(false),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("dsar_requests_dealer_idx").on(t.dealerId),
    index("dsar_requests_customer_idx").on(t.customerId),
  ],
);

export type DsarRequest = typeof dsarRequestsTable.$inferSelect;
