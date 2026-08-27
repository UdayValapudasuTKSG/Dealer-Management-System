import {
  pgTable,
  serial,
  text,
  integer,
  doublePrecision,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export type GateEvidenceItem = { label: string; value: string };

export const gatesTable = pgTable("gates", {
  id: serial("id").primaryKey(),
  dealerId: integer("dealer_id").notNull(),
  type: text("type").notNull(),
  status: text("status").notNull().default("pending"),
  priority: text("priority").notNull().default("normal"),
  customerId: integer("customer_id"),
  customerName: text("customer_name"),
  refType: text("ref_type"),
  refId: integer("ref_id"),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  recommendation: text("recommendation"),
  amount: doublePrecision("amount"),
  floorAmount: doublePrecision("floor_amount"),
  evidence: jsonb("evidence")
    .$type<GateEvidenceItem[]>()
    .notNull()
    .default([]),
  resolution: text("resolution"),
  resolvedBy: text("resolved_by"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertGateSchema = createInsertSchema(gatesTable, {
  type: z.enum([
    "below_floor_price",
    "fee_waiver",
    "credit_decline",
    "capital_order",
    "gra_filing",
    "refund_release",
    "stage_advance",
    "recall_damage",
    "bank_funds_received",
    "quote_discount",
    "quote_duty_free",
    "deal_cancellation",
    "lead_delete",
  ]),
  status: z.enum(["pending", "approved", "adjusted", "dismissed"]),
  priority: z.enum(["high", "normal", "low"]),
}).omit({ dealerId: true,
  id: true,
  createdAt: true,
});
export type InsertGate = z.infer<typeof insertGateSchema>;
export type Gate = typeof gatesTable.$inferSelect;
