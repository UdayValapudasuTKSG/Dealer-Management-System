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

/** Dealer lifecycle: suspended = data plane frozen, agents disabled. */
export const DEALER_STATUSES = ["active", "suspended"] as const;
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
  status: text("status").notNull().default("active"),
  // GYD per 1 USD — used to convert USD amounts into Guyana dollars in the UI.
  usdExchangeRate: doublePrecision("usd_exchange_rate")
    .notNull()
    .default(208.5),
  // Feature flags — missing keys mean "enabled".
  entitlements: jsonb("entitlements")
    .$type<DealerEntitlements>()
    .notNull()
    .default({}),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

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
