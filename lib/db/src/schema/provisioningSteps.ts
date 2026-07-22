import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { dealersTable } from "./dealers";

/**
 * Provisioning SAGA step keys, in canonical execution order (P2 NC-11).
 * External steps (side effects outside our DB) must never run inside a
 * held DB transaction — each is bracketed by two short local txns
 * (claim → run outside txn → record).
 */
export const PROVISIONING_STEP_KEYS = [
  "seed_roles",
  "seed_divisions",
  "seed_taxes",
  "seed_entitlements",
  "provision_storage",
  "seed_lead_sources",
  "seed_checklists",
  "seed_agents",
  "invite_owner_admin",
  "register_los",
] as const;
export type ProvisioningStepKey = (typeof PROVISIONING_STEP_KEYS)[number];

/** Steps whose side effect leaves the database (GCS / SMTP / LOS). */
export const EXTERNAL_PROVISIONING_STEPS: readonly ProvisioningStepKey[] = [
  "provision_storage",
  "invite_owner_admin",
  "register_los",
] as const;

export const PROVISIONING_STEP_STATUSES = [
  "pending",
  "in_progress",
  "done",
  "failed",
  "compensated",
] as const;
export type ProvisioningStepStatus =
  (typeof PROVISIONING_STEP_STATUSES)[number];

/**
 * Durable SAGA ledger: one row per dealer per step. Source of truth for
 * resume (re-drive from first non-done) and reverse compensation on abort.
 */
export const provisioningStepsTable = pgTable(
  "provisioning_steps",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id")
      .notNull()
      .references(() => dealersTable.id, { onDelete: "cascade" }),
    stepKey: text("step_key").notNull(),
    status: text("status", { enum: PROVISIONING_STEP_STATUSES })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    doneAt: timestamp("done_at", { withTimezone: true }),
    lastError: text("last_error"),
    compensationRunAt: timestamp("compensation_run_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("provisioning_steps_dealer_step_idx").on(t.dealerId, t.stepKey),
  ],
);
export type ProvisioningStep = typeof provisioningStepsTable.$inferSelect;

/**
 * Pending owner-admin (first GM) invites. Clerk JIT: when a user whose email
 * matches a pending invite signs in for the first time, the auth layer
 * creates their GM membership and marks the invite accepted.
 */
export const dealerInvitesTable = pgTable(
  "dealer_invites",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id")
      .notNull()
      .references(() => dealersTable.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    roleName: text("role_name").notNull().default("General Manager"),
    isGeneralManager: boolean("is_general_manager").notNull().default(true),
    status: text("status", { enum: ["pending", "accepted", "revoked"] })
      .notNull()
      .default("pending"),
    invitedBy: text("invited_by"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("dealer_invites_dealer_email_idx").on(t.dealerId, t.email)],
);
export type DealerInvite = typeof dealerInvitesTable.$inferSelect;
