import {
  pgTable,
  serial,
  text,
  integer,
  doublePrecision,
  date,
  timestamp,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Collision insurance claims (Task 279). A claim rides on TOP of a normal
 * repair order — the workshop lifecycle (job cards, parts, invoices) is
 * untouched; the claim adds insurer workflow, damage evidence, supplements
 * and the split insurer/deductible receivable.
 */
export const COLLISION_CLAIM_STATUSES = [
  "intake",
  "estimate_drafted",
  "submitted",
  "adjuster_review",
  "approved",
  "parts_ordered",
  "in_repair",
  "quality_check",
  "insurer_signoff",
  "invoiced",
  "closed",
  // Terminal outcomes recorded by staff (no automated valuation).
  "denied",
  "total_loss",
] as const;
export type CollisionClaimStatus = (typeof COLLISION_CLAIM_STATUSES)[number];

/** Adjacent-only transitions; decisions require a service approver. */
export const COLLISION_ADVANCE_MAP: Record<string, string[]> = {
  intake: ["estimate_drafted"],
  estimate_drafted: ["submitted"],
  submitted: ["adjuster_review", "denied"],
  adjuster_review: ["approved", "denied", "total_loss"],
  approved: ["parts_ordered", "total_loss"],
  parts_ordered: ["in_repair"],
  in_repair: ["quality_check"],
  quality_check: ["insurer_signoff", "in_repair"],
  insurer_signoff: ["invoiced"],
  invoiced: ["closed"],
  closed: [],
  denied: [],
  total_loss: [],
};

/** Statuses that need Service Manager / Management sign-off to enter. */
export const COLLISION_APPROVER_TARGETS = new Set([
  "approved",
  "insurer_signoff",
  "denied",
  "total_loss",
]);

/** Fixed vehicle silhouette zones for point-of-impact capture. */
export const COLLISION_DAMAGE_ZONES = [
  "front_bumper",
  "hood",
  "windshield",
  "front_left_fender",
  "front_right_fender",
  "left_door_front",
  "left_door_rear",
  "right_door_front",
  "right_door_rear",
  "left_quarter_panel",
  "right_quarter_panel",
  "roof",
  "rear_glass",
  "trunk",
  "rear_bumper",
  "undercarriage",
] as const;
export type CollisionDamageZone = (typeof COLLISION_DAMAGE_ZONES)[number];

export const COLLISION_SEVERITIES = ["minor", "moderate", "severe"] as const;
export type CollisionSeverity = (typeof COLLISION_SEVERITIES)[number];

export type CollisionDamagePoint = {
  zone: CollisionDamageZone;
  severity: CollisionSeverity;
  notes?: string | null;
};

/** Append-only audit timeline entry on the claim. */
export type CollisionClaimEvent = {
  kind:
    | "created"
    | "status"
    | "estimate"
    | "supplement"
    | "payment"
    | "pause"
    | "resume"
    | "note";
  from?: string | null;
  to?: string | null;
  note?: string | null;
  amount?: number | null;
  byUserId?: number | null;
  byName: string;
  at: string;
};

export const collisionClaimsTable = pgTable(
  "collision_claims",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    /** One claim per repair order (enforced by a dealer-scoped unique index). */
    serviceOrderId: integer("service_order_id").notNull(),
    customerId: integer("customer_id"),
    customerName: text("customer_name"),
    vehicleInfo: text("vehicle_info").notNull(),
    vehicleId: integer("vehicle_id"),
    lossDate: date("loss_date", { mode: "string" }).notNull(),
    insurerName: text("insurer_name").notNull(),
    policyNumber: text("policy_number"),
    /** Insurer claim number — unique per dealer+insurer when present. */
    claimNumber: text("claim_number"),
    adjusterName: text("adjuster_name"),
    adjusterContact: text("adjuster_contact"),
    severity: text("severity").notNull().default("moderate"),
    damageNotes: text("damage_notes"),
    /** Fixed silhouette zone selections with per-zone severity/notes. */
    damagePoints: jsonb("damage_points")
      .$type<CollisionDamagePoint[]>()
      .notNull()
      .default([]),
    status: text("status").notNull().default("intake"),
    /** Estimate track: initial → contested (insurer pushback) → approved. */
    initialEstimate: doublePrecision("initial_estimate").notNull().default(0),
    contestedEstimate: doublePrecision("contested_estimate"),
    approvedEstimate: doublePrecision("approved_estimate"),
    deductible: doublePrecision("deductible").notNull().default(0),
    /** Total-loss outcome evidence (staff-recorded, no automated valuation). */
    totalLossValue: doublePrecision("total_loss_value"),
    outcomeReason: text("outcome_reason"),
    /** Cycle-time pause around backordered parts: accumulated + open segment. */
    pausedSeconds: integer("paused_seconds").notNull().default(0),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    /** Invoiced split, stamped when the service invoice is issued. */
    serviceInvoiceId: integer("service_invoice_id"),
    insurerDue: doublePrecision("insurer_due"),
    deductibleDue: doublePrecision("deductible_due"),
    /** Append-only status/estimate/supplement/payment event timeline. */
    history: jsonb("history")
      .$type<CollisionClaimEvent[]>()
      .notNull()
      .default([]),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("collision_claims_service_order_unique").on(t.serviceOrderId),
    uniqueIndex("collision_claims_insurer_claim_number_unique")
      .on(t.dealerId, sql`lower(${t.insurerName})`, sql`lower(${t.claimNumber})`)
      .where(sql`${t.claimNumber} is not null and ${t.claimNumber} <> ''`),
  ],
);

export const insertCollisionClaimSchema = createInsertSchema(
  collisionClaimsTable,
  {
    status: z.enum(COLLISION_CLAIM_STATUSES),
    severity: z.enum(COLLISION_SEVERITIES),
  },
).omit({
  dealerId: true,
  id: true,
  createdAt: true,
  history: true,
  pausedSeconds: true,
  pausedAt: true,
  serviceInvoiceId: true,
  insurerDue: true,
  deductibleDue: true,
  closedAt: true,
});
export type InsertCollisionClaim = z.infer<typeof insertCollisionClaimSchema>;
export type CollisionClaim = typeof collisionClaimsTable.$inferSelect;

// ---------------------------------------------------------------------------
// Supplements — itemized hidden-damage additions with their own decision
// lifecycle, independent of the parent claim status.
// ---------------------------------------------------------------------------

export const COLLISION_SUPPLEMENT_STATUSES = [
  "pending",
  "approved",
  "denied",
] as const;
export type CollisionSupplementStatus =
  (typeof COLLISION_SUPPLEMENT_STATUSES)[number];

export const collisionSupplementsTable = pgTable("collision_supplements", {
  id: serial("id").primaryKey(),
  dealerId: integer("dealer_id").notNull(),
  claimId: integer("claim_id")
    .notNull()
    .references(() => collisionClaimsTable.id, { onDelete: "cascade" }),
  description: text("description").notNull(),
  amount: doublePrecision("amount").notNull(),
  status: text("status").notNull().default("pending"),
  decisionNote: text("decision_note"),
  requestedBy: text("requested_by"),
  decidedBy: text("decided_by"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export type CollisionSupplement = typeof collisionSupplementsTable.$inferSelect;

// ---------------------------------------------------------------------------
// Settlements — the split receivable ledger (insurer share vs deductible).
// ---------------------------------------------------------------------------

export const COLLISION_PAYERS = ["insurer", "customer"] as const;
export type CollisionPayer = (typeof COLLISION_PAYERS)[number];

export const collisionSettlementsTable = pgTable("collision_settlements", {
  id: serial("id").primaryKey(),
  dealerId: integer("dealer_id").notNull(),
  claimId: integer("claim_id")
    .notNull()
    .references(() => collisionClaimsTable.id, { onDelete: "cascade" }),
  payer: text("payer").notNull(),
  amount: doublePrecision("amount").notNull(),
  method: text("method"),
  reference: text("reference"),
  recordedBy: text("recorded_by"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export type CollisionSettlement = typeof collisionSettlementsTable.$inferSelect;
