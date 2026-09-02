import {
  pgTable,
  serial,
  integer,
  text,
  doublePrecision,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { serviceOrdersTable } from "./serviceOrders";
import { jobCardsTable } from "./workshop";

export type ServiceEstimateLine = {
  kind: "part" | "labour";
  description: string;
  quantity?: number;
  amount: number;
};

/**
 * Public estimate decisions. Only a SHA-256 digest is persisted; the bearer
 * token exists briefly in the customer email payload. Decisions are whole
 * estimate only and are committed with a decision IS NULL compare-and-set.
 */
export const serviceEstimateDecisionsTable = pgTable(
  "service_estimate_decisions",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    serviceOrderId: integer("service_order_id").notNull().references(() => serviceOrdersTable.id),
    jobCardId: integer("job_card_id").notNull().references(() => jobCardsTable.id),
    tokenHash: text("token_hash").notNull(),
    estimateTotal: doublePrecision("estimate_total").notNull(),
    linesSnapshot: jsonb("lines_snapshot")
      .$type<ServiceEstimateLine[]>()
      .notNull()
      .default([]),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    decision: text("decision"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("service_estimate_decisions_token_hash_uq").on(t.tokenHash),
    index("service_estimate_decisions_entity_idx").on(
      t.dealerId,
      t.serviceOrderId,
      t.jobCardId,
    ),
  ],
);

export type ServiceEstimateDecision =
  typeof serviceEstimateDecisionsTable.$inferSelect;