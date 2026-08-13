import {
  pgTable,
  serial,
  text,
  integer,
  doublePrecision,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { rolesTable } from "./roles";
import { usersTable } from "./users";

/**
 * Canonical dealer control-plane machine (NC-3):
 * provisioning → active → suspended → offboarding → closed.
 * suspended = data plane frozen (writes 423), agents disabled.
 */
export const DEALER_STATUSES = [
  "provisioning",
  "active",
  "suspended",
  "offboarding",
  "closed",
] as const;
export type DealerStatus = (typeof DEALER_STATUSES)[number];

/**
 * Per-dealer entitlements (feature flags). Missing keys default to enabled
 * so existing dealers keep full functionality until explicitly restricted.
 */
export const ENTITLEMENT_KEYS = [
  "ai_agents",
  "whatsapp_bot",
  "gmail_intake",
  "finance_los",
  "gra_module",
  "service_module",
  "parts_module",
] as const;
export type EntitlementKey = (typeof ENTITLEMENT_KEYS)[number];
export type DealerEntitlements = Partial<Record<EntitlementKey, boolean>>;

export const dealersTable = pgTable("dealers", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  city: text("city"),
  country: text("country"),
  /** Dealer's GRA Taxpayer Identification Number — printed on duty packs, never AI-generated. */
  tin: text("tin"),
  // White-label branding (GM-managed): display name + uploaded logo shown
  // across the app shell and printed on invoices/quotes/receipts. Null =
  // fall back to the default AURA branding.
  brandName: text("brand_name"),
  logoUrl: text("logo_url"),
  // Super-admin-managed theme accent (hex, e.g. "#B91C1C"). Applied to the
  // dealership's AURA workspace in LIGHT mode only; null = default bronze.
  themeColor: text("theme_color"),
  // Contact details printed on customer-facing documents (e.g. the warranty
  // certificate): street address, service line(s), 24h emergency line.
  address: text("address"),
  servicePhone: text("service_phone"),
  emergencyPhone: text("emergency_phone"),
  status: text("status").notNull().default("active"),
  // GYD per 1 USD — used to convert USD amounts into Guyana dollars in the UI.
  usdExchangeRate: doublePrecision("usd_exchange_rate")
    .notNull()
    .default(1),
  // Parts pricing: cost-plus markup percentage applied when a bulk import
  // (or costing tool) derives a sell price from unit cost.
  partsMarkupPercent: doublePrecision("parts_markup_percent")
    .notNull()
    .default(25),
  // Meta (Facebook/Instagram) page id that routes Lead Ads webhook events to
  // this dealer. Unmapped page ids are rejected (fail closed, no lead write).
  metaPageId: text("meta_page_id"),
  // Feature flags — missing keys mean "enabled".
  entitlements: jsonb("entitlements")
    .$type<DealerEntitlements>()
    .notNull()
    .default({}),
  createdBy: text("created_by"),
  // P3 offboarding/close controls: a legal hold blocks close (and purge);
  // offboardedAt starts the retention clock, retentionUntil gates close;
  // exportUrl is the whole-tenant offboarding export bundle location.
  legalHold: boolean("legal_hold").notNull().default(false),
  offboardedAt: timestamp("offboarded_at", { withTimezone: true }),
  retentionUntil: timestamp("retention_until", { withTimezone: true }),
  exportUrl: text("export_url"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Canonical lifecycle transition table (P3): every status change must be an
 * allowed hop; illegal jumps → 409. Terminal: closed (re-provision to return).
 */
export const DEALER_STATUS_TRANSITIONS: Record<DealerStatus, DealerStatus[]> = {
  provisioning: ["active", "closed"], // closed via saga abort
  active: ["suspended", "offboarding"],
  suspended: ["active", "offboarding"],
  offboarding: ["closed"],
  closed: [],
};

/** Audited super-admin impersonation grants: required before a super admin
 * may bind a dealer's workspace via the x-dealer-id header. */
export const impersonationGrantsTable = pgTable("impersonation_grants", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  dealerId: integer("dealer_id")
    .notNull()
    .references(() => dealersTable.id, { onDelete: "cascade" }),
  reason: text("reason"),
  /** NC-10: impersonation is read-only by default; writes need explicit elevation. */
  mode: text("mode", { enum: ["read_only", "elevated"] })
    .notNull()
    .default("read_only"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
export type ImpersonationGrant = typeof impersonationGrantsTable.$inferSelect;

export const dealerUsersTable = pgTable(
  "dealer_users",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id")
      .notNull()
      .references(() => dealersTable.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    roleId: integer("role_id")
      .notNull()
      .references(() => rolesTable.id),
    isGeneralManager: boolean("is_general_manager").notNull().default(false),
    // Timestamp-based round robin: stamped whenever a lead is assigned to
    // this member (auto or manual). Oldest (or never) goes next.
    lastLeadAssignedAt: timestamp("last_lead_assigned_at", {
      withTimezone: true,
    }),
    // Employee master: who this member reports to (users.id of a manager in
    // the same dealership) and which business division they belong to.
    reportingManagerUserId: integer("reporting_manager_user_id"),
    divisionId: integer("division_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("dealer_users_dealer_user_idx").on(t.dealerId, t.userId)],
);

export const insertDealerSchema = createInsertSchema(dealersTable, {
  status: z.enum(DEALER_STATUSES),
}).omit({ id: true, createdAt: true });
export type InsertDealer = z.infer<typeof insertDealerSchema>;
export type Dealer = typeof dealersTable.$inferSelect;

export const insertDealerUserSchema = createInsertSchema(
  dealerUsersTable,
).omit({ id: true, createdAt: true });
export type InsertDealerUser = z.infer<typeof insertDealerUserSchema>;
export type DealerUser = typeof dealerUsersTable.$inferSelect;
