import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Customer cases — complaints, exceptions and escalations (spec R1 / V1
 * 2.15). Dealer-scoped, polymorphically linked to the record they concern
 * (lead / deal / service_order / delivery), with a simple open → in_progress
 * → resolved → closed lifecycle.
 */
export const CASE_TYPES = ["complaint", "exception", "inquiry"] as const;
export type CaseType = (typeof CASE_TYPES)[number];

export const CASE_SEVERITIES = ["low", "medium", "high"] as const;
export type CaseSeverity = (typeof CASE_SEVERITIES)[number];

/** Canonical Case machine (NC-3): open → acknowledged → in_progress → on_hold → resolved → closed (+ cancelled). */
export const CASE_STATUSES = [
  "open",
  "acknowledged",
  "in_progress",
  "on_hold",
  "resolved",
  "closed",
  "cancelled",
] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export const casesTable = pgTable(
  "service_cases",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    customerId: integer("customer_id"),
    customerName: text("customer_name"),
    title: text("title").notNull(),
    description: text("description"),
    type: text("type").notNull().default("complaint"),
    severity: text("severity").notNull().default("medium"),
    status: text("status").notNull().default("open"),
    /** Polymorphic link: lead | deal | service_order | delivery. */
    refType: text("ref_type"),
    refId: integer("ref_id"),
    assignedTo: text("assigned_to"),
    resolutionNote: text("resolution_note"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("service_cases_dealer_status_idx").on(t.dealerId, t.status),
    index("service_cases_dealer_customer_idx").on(t.dealerId, t.customerId),
  ],
);

export const insertCaseSchema = createInsertSchema(casesTable, {
  type: z.enum(CASE_TYPES),
  severity: z.enum(CASE_SEVERITIES),
  status: z.enum(CASE_STATUSES),
}).omit({ dealerId: true, id: true, createdAt: true });
export type InsertCase = z.infer<typeof insertCaseSchema>;
export type CustomerCase = typeof casesTable.$inferSelect;
