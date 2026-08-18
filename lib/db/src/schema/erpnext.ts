import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// ERPNext integration foundation (Task: ERPNext connection & sync engine).
// Per-dealer connection credentials, a durable outbound sync-job queue,
// a generic external-reference mapping (AURA record ↔ ERPNext doc name),
// and an inbound webhook event ledger.
// ---------------------------------------------------------------------------

/** Per-dealer ERPNext connection credentials + last-known health. Secrets
 * (apiKey/apiSecret) are NEVER returned to the client in full. */
export const erpnextConnectionsTable = pgTable(
  "erpnext_connections",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    /** e.g. https://mycompany.frappe.cloud (no trailing slash). */
    siteUrl: text("site_url").notNull(),
    apiKey: text("api_key").notNull(),
    apiSecret: text("api_secret").notNull(),
    /** Shared secret ERPNext webhooks must present (X-AURA-Webhook-Secret). */
    webhookSecret: text("webhook_secret").notNull(),
    /** Master switch: disabled pauses outbound sync without losing config. */
    enabled: boolean("enabled").notNull().default(true),
    /** Default ERPNext warehouse for parts stock movements (one per dealer). */
    defaultWarehouse: text("default_warehouse"),
    /** Last test/health result: connected | error | null (never tested). */
    lastStatus: text("last_status"),
    lastError: text("last_error"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    /** Accounting mapping: ERPNext income account for invoice line items. */
    incomeAccount: text("income_account"),
    /** Accounting mapping: ERPNext account head for AURA tax snapshot lines. */
    taxAccount: text("tax_account"),
    /** AURA payment method → ERPNext Mode of Payment (e.g. cash → "Cash"). */
    paymentModes: jsonb("payment_modes").$type<Record<string, string>>(),
    /** ERPNext receivable (Debtors) account for Payment Entries. */
    receivableAccount: text("receivable_account"),
    /** ERPNext cash/bank account payments settle into (paid_to for Receive). */
    settlementAccount: text("settlement_account"),
    /** ERPNext site timezone (System Settings.time_zone) — naive webhook
     * timestamps are interpreted in this zone for conflict ordering. */
    siteTimezone: text("site_timezone"),
    /** Reported by the test-connection call. */
    companyName: text("company_name"),
    erpnextVersion: text("erpnext_version"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("erpnext_connections_dealer_uq").on(t.dealerId)],
);
export type ErpnextConnection = typeof erpnextConnectionsTable.$inferSelect;

export const ERPNEXT_SYNC_STATUSES = [
  "queued",
  "processing",
  "succeeded",
  "failed",
  "dead",
] as const;
export type ErpnextSyncStatus = (typeof ERPNEXT_SYNC_STATUSES)[number];

/** Durable outbound sync queue (outbox pattern): one row per sync attempt
 * unit, retried with backoff, dead-lettered after repeated failures. */
export const erpnextSyncJobsTable = pgTable(
  "erpnext_sync_jobs",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    /** outbound (AURA → ERPNext) | inbound (ERPNext → AURA). */
    direction: text("direction").notNull().default("outbound"),
    /** Target ERPNext DocType, e.g. "Customer", "Sales Invoice". */
    doctype: text("doctype").notNull(),
    /** insert | update — generic worker behavior when no handler is bound. */
    operation: text("operation").notNull().default("insert"),
    /** AURA-side record this job syncs (e.g. "customer", 42). */
    entityType: text("entity_type").notNull(),
    entityId: integer("entity_id").notNull(),
    /** Document fields to push (DocType payload). */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    /** Idempotency: a second enqueue with the same key is a no-op. */
    dedupeKey: text("dedupe_key").unique(),
    status: text("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    /** ERPNext document name once known (also mirrored in erpnext_refs). */
    erpnextDocName: text("erpnext_doc_name"),
    /** Earliest time the worker may (re)try this job. */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("erpnext_sync_jobs_status_idx").on(t.status, t.nextAttemptAt),
    index("erpnext_sync_jobs_dealer_idx").on(t.dealerId, t.createdAt),
  ],
);
export type ErpnextSyncJob = typeof erpnextSyncJobsTable.$inferSelect;

/** Generic external-reference mapping: which ERPNext document an AURA record
 * corresponds to, so updates go to the right doc. */
export const erpnextRefsTable = pgTable(
  "erpnext_refs",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: integer("entity_id").notNull(),
    doctype: text("doctype").notNull(),
    docName: text("doc_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("erpnext_refs_entity_uq").on(
      t.dealerId,
      t.entityType,
      t.entityId,
      t.doctype,
    ),
    index("erpnext_refs_doc_idx").on(t.dealerId, t.doctype, t.docName),
  ],
);
export type ErpnextRef = typeof erpnextRefsTable.$inferSelect;

/** Inbound webhook events from ERPNext (recorded, then dispatched to
 * per-DocType handlers — the handlers land in the follow-on sync tasks). */
export const erpnextWebhookEventsTable = pgTable(
  "erpnext_webhook_events",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    doctype: text("doctype"),
    docName: text("doc_name"),
    /** ERPNext webhook event, e.g. on_update / after_insert / on_trash. */
    event: text("event"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    /** received | processed | skipped | error. */
    status: text("status").notNull().default("received"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("erpnext_webhook_events_dealer_idx").on(t.dealerId, t.createdAt)],
);
export type ErpnextWebhookEvent = typeof erpnextWebhookEventsTable.$inferSelect;
