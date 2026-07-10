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

export const insertGateSchema = createInsertSchema(gatesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertGate = z.infer<typeof insertGateSchema>;
export type Gate = typeof gatesTable.$inferSelect;
