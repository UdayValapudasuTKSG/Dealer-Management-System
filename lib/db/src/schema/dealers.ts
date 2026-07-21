import {
  pgTable,
  serial,
  text,
  integer,
  doublePrecision,
  boolean,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { rolesTable } from "./roles";
import { usersTable } from "./users";

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
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

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
  status: z.enum(["active", "inactive"]),
}).omit({ id: true, createdAt: true });
export type InsertDealer = z.infer<typeof insertDealerSchema>;
export type Dealer = typeof dealersTable.$inferSelect;

export const insertDealerUserSchema = createInsertSchema(
  dealerUsersTable,
).omit({ id: true, createdAt: true });
export type InsertDealerUser = z.infer<typeof insertDealerUserSchema>;
export type DealerUser = typeof dealerUsersTable.$inferSelect;
