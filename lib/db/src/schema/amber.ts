import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  doublePrecision,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Amber Connect vehicle telematics module (dealer-scoped, entitlement-gated).
//
// Every table here is hard-scoped by dealerId. The module entitlement
// ("amber_connect") is DISABLED BY DEFAULT — a missing key means disabled,
// unlike the legacy deny-list flags (see DEFAULT_DISABLED_ENTITLEMENTS in
// dealers.ts). Credentials are AES-256-GCM ciphertext, server-only.
// ---------------------------------------------------------------------------

/** Per-dealer Amber Connect connection settings + health metadata. */
export const amberConnectionsTable = pgTable(
  "amber_connections",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    /** Dealer's own on/off switch (independent of the platform entitlement). */
    enabled: boolean("enabled").notNull().default(false),
    /**
     * Base URL of the dealer's Amber Connect API endpoint, stored only once
     * official partner documentation supplies it. Null = contract pending.
     */
    apiBaseUrl: text("api_base_url"),
    /**
     * AES-256-GCM ciphertext of the Amber API credential, wire format
     * <iv>:<tag>:<ciphertext> (base64). Never returned to the client.
     */
    apiKeyCiphertext: text("api_key_ciphertext"),
    /** First 4 chars of the credential for display; never the full value. */
    apiKeyHint: text("api_key_hint"),
    /**
     * Shared secret used to HMAC-verify inbound Amber webhook deliveries to
     * AURA's ingestion endpoint. GM-readable (they must configure the sender),
     * mirroring the ERPNext webhook secret.
     */
    webhookSecret: text("webhook_secret").notNull(),
    /** Last connection test: "connected" | "error" | "pending_contract" | null. */
    lastStatus: text("last_status"),
    lastError: text("last_error"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    /** Last scheduled sync outcome: "ok" | "pending_contract" | "error" | null. */
    lastSyncStatus: text("last_sync_status"),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("amber_connections_dealer_uq").on(t.dealerId)],
);
export type AmberConnection = typeof amberConnectionsTable.$inferSelect;

export const AMBER_MAPPING_STATUSES = [
  "unmatched",
  "mapped",
  "conflict",
] as const;
export type AmberMappingStatus = (typeof AMBER_MAPPING_STATUSES)[number];

/** Amber devices known to a dealership and their vehicle mapping state. */
export const amberDevicesTable = pgTable(
  "amber_devices",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    /** Provider device identity (IMEI / device serial as supplied). */
    deviceId: text("device_id").notNull(),
    /** VIN as reported by the provider (may be absent or wrong-cased). */
    reportedVin: text("reported_vin"),
    label: text("label"),
    /** Explicit mapping to an AURA vehicle — set only by a confirmed action. */
    vehicleId: integer("vehicle_id"),
    mappingStatus: text("mapping_status").notNull().default("unmatched"),
    /** Why a device is in "conflict" (e.g. VIN matches a different dealer's or an already-mapped vehicle). */
    conflictReason: text("conflict_reason"),
    mappedBy: text("mapped_by"),
    mappedAt: timestamp("mapped_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("amber_devices_dealer_device_uq").on(t.dealerId, t.deviceId),
    index("amber_devices_vehicle_idx").on(t.vehicleId),
    // One active device per vehicle — enforced in the database so concurrent
    // mapping requests cannot both win (23505 → 409 conflict in the route).
    uniqueIndex("amber_devices_dealer_vehicle_uq")
      .on(t.dealerId, t.vehicleId)
      .where(sql`vehicle_id is not null`),
  ],
);
export type AmberDevice = typeof amberDevicesTable.$inferSelect;

export const AMBER_EVENT_TYPES = [
  "location",
  "odometer",
  "ignition_on",
  "ignition_off",
  "device_health",
  "other",
] as const;
export type AmberEventType = (typeof AMBER_EVENT_TYPES)[number];

/**
 * Idempotency ledger + bounded history of ingested Amber events. The unique
 * (dealerId, externalId) claim makes duplicate webhook deliveries no-ops.
 */
export const amberEventsTable = pgTable(
  "amber_events",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    deviceId: text("device_id").notNull(),
    /** Provider-supplied unique event id (idempotency key). */
    externalId: text("external_id").notNull(),
    type: text("type").notNull(),
    /** Provider event timestamp — drives monotonic state updates. */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    /** "processed" | "stale" (older than current state) | "unmapped" | "error" */
    status: text("status").notNull().default("processed"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("amber_events_dealer_external_uq").on(t.dealerId, t.externalId),
    index("amber_events_dealer_device_idx").on(t.dealerId, t.deviceId),
    index("amber_events_created_idx").on(t.createdAt),
  ],
);
export type AmberEvent = typeof amberEventsTable.$inferSelect;

/** Latest normalized telemetry per device (one row per dealer+device). */
export const amberVehicleStatesTable = pgTable(
  "amber_vehicle_states",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    deviceId: text("device_id").notNull(),
    vehicleId: integer("vehicle_id"),
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    /** Timestamp of the event that produced the current location. */
    locationAt: timestamp("location_at", { withTimezone: true }),
    odometerKm: doublePrecision("odometer_km"),
    odometerAt: timestamp("odometer_at", { withTimezone: true }),
    ignitionOn: boolean("ignition_on"),
    ignitionAt: timestamp("ignition_at", { withTimezone: true }),
    /** "ok" | "low_battery" | "offline" | "tamper" | free-form provider value */
    deviceHealth: text("device_health"),
    deviceHealthAt: timestamp("device_health_at", { withTimezone: true }),
    /** Most recent event of ANY kind — drives freshness/stale labelling. */
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("amber_states_dealer_device_uq").on(t.dealerId, t.deviceId),
    index("amber_states_vehicle_idx").on(t.vehicleId),
  ],
);
export type AmberVehicleState = typeof amberVehicleStatesTable.$inferSelect;
