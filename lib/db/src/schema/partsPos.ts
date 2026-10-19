import { pgTable, serial, integer, text, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const partsPosSettingsTable = pgTable("parts_pos_settings", {
  dealerId: integer("dealer_id").primaryKey(),
  revision: integer("revision").notNull().default(1),
  config: jsonb("config").$type<Record<string, unknown>>().notNull(),
  validation: jsonb("validation").$type<{ state: string; errors: string[] }>().notNull(),
  updatedBy: integer("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const partsPosRequestsTable = pgTable("parts_pos_requests", {
  id: serial("id").primaryKey(),
  dealerId: integer("dealer_id").notNull(),
  kind: text("kind").notNull(),
  status: text("status").notNull().default("pending"),
  requestKey: text("request_key").notNull(),
  revision: integer("revision").notNull(),
  input: jsonb("input").$type<Record<string, unknown>>().notNull(),
  snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
  createdBy: integer("created_by").notNull(),
  decidedBy: integer("decided_by"),
  decisionNote: text("decision_note"),
  error: text("error"),
  erpDocuments: jsonb("erp_documents").$type<{ doctype: string; name: string }[]>().notNull().default([]),
  reconciliationReference: text("reconciliation_reference"),
  reconciledBy: integer("reconciled_by"),
  reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, t => [uniqueIndex("parts_pos_requests_key_uq").on(t.dealerId, t.requestKey)]);
