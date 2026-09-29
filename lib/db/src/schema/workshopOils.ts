import { pgTable, integer, text, numeric, boolean, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { jobCardsTable, serviceInvoicesTable } from "./workshop";

const quantity = (name: string) => numeric(name, { precision: 15, scale: 3 });
const price = (name: string) => numeric(name, { precision: 15, scale: 2 });
export const workshopOilsTable = pgTable("workshop_oils", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(), dealerId: integer("dealer_id").notNull(),
  name: text("name").notNull(), grade: text("grade").notNull().default(""),
  specification: text("specification").notNull().default(""), brand: text("brand").notNull().default(""),
  purchaseCostPerLitre: price("purchase_cost_per_litre").notNull().default("0"),
  sellingPricePerLitre: price("selling_price_per_litre").notNull().default("0"),
  stockLitres: quantity("stock_litres").notNull().default("0"),
  reorderLitres: quantity("reorder_litres").notNull().default("0"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index("workshop_oils_dealer_idx").on(t.dealerId, t.name),
  check("workshop_oils_purchase_ck", sql`${t.purchaseCostPerLitre} >= 0`),
  check("workshop_oils_selling_ck", sql`${t.sellingPricePerLitre} >= 0`),
  check("workshop_oils_stock_ck", sql`${t.stockLitres} >= 0`),
  check("workshop_oils_reorder_ck", sql`${t.reorderLitres} >= 0`),
]);
export const insertWorkshopOilSchema = createInsertSchema(workshopOilsTable).omit({ id: true, dealerId: true, createdAt: true, updatedAt: true });
export type InsertWorkshopOil = z.infer<typeof insertWorkshopOilSchema>;
export type WorkshopOilRow = typeof workshopOilsTable.$inferSelect;

export const workshopOilRequestsTable = pgTable("workshop_oil_requests", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(), dealerId: integer("dealer_id").notNull(),
  jobCardId: integer("job_card_id").notNull().references(() => jobCardsTable.id),
  oilId: integer("oil_id").notNull().references(() => workshopOilsTable.id),
  requestedLitres: quantity("requested_litres").notNull(),
  issuedLitres: quantity("issued_litres").notNull().default("0"),
  returnedLitres: quantity("returned_litres").notNull().default("0"),
  status: text("status").notNull().default("requested"),
  approvedBy: integer("approved_by"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  nameSnapshot: text("name_snapshot").notNull(), unitPricePerLitre: price("unit_price_per_litre").notNull(),
  requestedBy: integer("requested_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index("workshop_oil_requests_job_idx").on(t.dealerId, t.jobCardId),
  index("workshop_oil_requests_oil_idx").on(t.dealerId, t.oilId),
  check("workshop_oil_requests_positive_ck", sql`${t.requestedLitres} > 0 AND ${t.issuedLitres} >= 0 AND ${t.issuedLitres} <= ${t.requestedLitres} AND ${t.returnedLitres} >= 0 AND ${t.returnedLitres} <= ${t.issuedLitres}`),
  check("workshop_oil_requests_status_ck", sql`${t.status} IN ('requested','approved','partial','issued','cancelled')`),
]);
export const insertWorkshopOilRequestSchema = createInsertSchema(workshopOilRequestsTable).omit({ id: true, dealerId: true, createdAt: true, updatedAt: true });
export type InsertWorkshopOilRequest = z.infer<typeof insertWorkshopOilRequestSchema>;
export type WorkshopOilRequestRow = typeof workshopOilRequestsTable.$inferSelect;

export const workshopOilMovementsTable = pgTable("workshop_oil_movements", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(), dealerId: integer("dealer_id").notNull(),
  oilId: integer("oil_id").notNull().references(() => workshopOilsTable.id),
  requestId: integer("request_id").references(() => workshopOilRequestsTable.id),
  deltaLitres: quantity("delta_litres").notNull(), reason: text("reason").notNull(),
  actorId: integer("actor_id"), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index("workshop_oil_movements_oil_idx").on(t.dealerId, t.oilId, t.createdAt),
  check("workshop_oil_movements_delta_ck", sql`${t.deltaLitres} <> 0`),
  check("workshop_oil_movements_reason_ck", sql`${t.reason} IN ('opening','adjustment','issue','return')`),
]);
export const insertWorkshopOilMovementSchema = createInsertSchema(workshopOilMovementsTable).omit({ id: true, createdAt: true });
export type InsertWorkshopOilMovement = z.infer<typeof insertWorkshopOilMovementSchema>;

export const workshopInvoiceOilsTable = pgTable("workshop_invoice_oils", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(), dealerId: integer("dealer_id").notNull(),
  invoiceId: integer("invoice_id").notNull().references(() => serviceInvoicesTable.id),
  requestId: integer("request_id").notNull().references(() => workshopOilRequestsTable.id),
  nameSnapshot: text("name_snapshot").notNull(),
  quantityLitres: quantity("quantity_litres").notNull(),
  unitPricePerLitre: price("unit_price_per_litre").notNull(), amount: price("amount").notNull(),
}, t => [
  uniqueIndex("workshop_invoice_oils_dealer_request_uq").on(t.dealerId, t.requestId),
  index("workshop_invoice_oils_invoice_idx").on(t.dealerId, t.invoiceId),
  check("workshop_invoice_oils_quantity_ck", sql`${t.quantityLitres} > 0`),
]);
export const insertWorkshopInvoiceOilSchema = createInsertSchema(workshopInvoiceOilsTable).omit({ id: true });
export type InsertWorkshopInvoiceOil = z.infer<typeof insertWorkshopInvoiceOilSchema>;