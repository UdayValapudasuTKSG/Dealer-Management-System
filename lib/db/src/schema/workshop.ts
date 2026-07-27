import {
  pgTable,
  serial,
  text,
  integer,
  doublePrecision,
  date,
  timestamp,
  jsonb,
  boolean,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

export const suppliersTable = pgTable("suppliers", {
  id: serial("id").primaryKey(),
  dealerId: integer("dealer_id").notNull(),
  name: text("name").notNull(),
  contactName: text("contact_name"),
  email: text("email"),
  phone: text("phone"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertSupplierSchema = createInsertSchema(suppliersTable).omit({ dealerId: true,
  id: true,
  createdAt: true,
});
export type InsertSupplier = z.infer<typeof insertSupplierSchema>;
export type Supplier = typeof suppliersTable.$inferSelect;

// ---------------------------------------------------------------------------
// Parts inventory
// ---------------------------------------------------------------------------

/** Part lifecycle (Module C): active | superseded | obsolete. */
export const PART_STATUSES = ["active", "superseded", "obsolete"] as const;
export type PartStatus = (typeof PART_STATUSES)[number];

export const partsTable = pgTable("parts", {
  id: serial("id").primaryKey(),
  dealerId: integer("dealer_id").notNull(),
  sku: text("sku").notNull().unique(),
  name: text("name").notNull(),
  category: text("category").notNull().default("general"),
  supplierId: integer("supplier_id").references(() => suppliersTable.id),
  unitCost: doublePrecision("unit_cost").notNull().default(0),
  unitPrice: doublePrecision("unit_price").notNull().default(0),
  stock: integer("stock").notNull().default(0),
  reorderLevel: integer("reorder_level").notNull().default(5),
  status: text("status").notNull().default("active"),
  supersededByPartId: integer("superseded_by_part_id"),
  location: text("location"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertPartSchema = createInsertSchema(partsTable).omit({ dealerId: true,
  id: true,
  createdAt: true,
});
export type InsertPart = z.infer<typeof insertPartSchema>;
export type Part = typeof partsTable.$inferSelect;

// ---------------------------------------------------------------------------
// Part purchases (manual purchase records; receiving increments stock)
// ---------------------------------------------------------------------------

/** PO lifecycle (Module C): ordered → partially_received → received (+ cancelled). Legacy rows default received. */
export const PART_PURCHASE_STATUSES = [
  "ordered",
  "partially_received",
  "received",
  "cancelled",
] as const;
export type PartPurchaseStatus = (typeof PART_PURCHASE_STATUSES)[number];

export const partPurchasesTable = pgTable("part_purchases", {
  id: serial("id").primaryKey(),
  dealerId: integer("dealer_id").notNull(),
  partId: integer("part_id")
    .notNull()
    .references(() => partsTable.id),
  supplierId: integer("supplier_id").references(() => suppliersTable.id),
  quantity: integer("quantity").notNull(),
  qtyReceived: integer("qty_received").notNull().default(0),
  status: text("status").notNull().default("received"),
  expectedDate: date("expected_date", { mode: "string" }),
  unitCost: doublePrecision("unit_cost").notNull().default(0),
  reference: text("reference"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertPartPurchaseSchema = createInsertSchema(
  partPurchasesTable,
).omit({ dealerId: true, id: true, createdAt: true });
export type InsertPartPurchase = z.infer<typeof insertPartPurchaseSchema>;
export type PartPurchase = typeof partPurchasesTable.$inferSelect;

// ---------------------------------------------------------------------------
// Job cards
// ---------------------------------------------------------------------------

export type ChecklistItem = { label: string; done: boolean };

/** Canonical job-card machine (NC-3): open → in_progress → on_hold → completed → closed (+ cancelled). */
export const JOB_CARD_STATUSES = [
  "open",
  "in_progress",
  "on_hold",
  "completed",
  "closed",
  "cancelled",
] as const;
export type JobCardStatus = (typeof JOB_CARD_STATUSES)[number];

/** Intake / outtake condition snapshot recorded on the work order (L11 §7/§10). */
export type ConditionRecord = {
  odometer?: number;
  fuelLevel?: string;
  loanerIssued?: boolean;
  notes?: string;
  signature?: string;
  recordedAt?: string;
};

export const jobCardsTable = pgTable(
  "job_cards",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    serviceOrderId: integer("service_order_id").notNull(),
    assetId: integer("asset_id"),
    title: text("title").notNull(),
    status: text("status").notNull().default("open"),
    technicianUserId: integer("technician_user_id"),
    technicianName: text("technician_name"),
    bay: text("bay"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    durationMins: integer("duration_mins"),
    payType: text("pay_type").notNull().default("customer"),
    quoteTotal: doublePrecision("quote_total").notNull().default(0),
    quoteApprovedAt: timestamp("quote_approved_at", { withTimezone: true }),
    intake: jsonb("intake").$type<ConditionRecord | null>(),
    outtake: jsonb("outtake").$type<ConditionRecord | null>(),
    checklist: jsonb("checklist")
      .$type<ChecklistItem[]>()
      .notNull()
      .default([]),
    laborHours: doublePrecision("labor_hours").notNull().default(0),
    laborRate: doublePrecision("labor_rate").notNull().default(120),
    notes: text("notes"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // L11 invariant: exactly one active work order per asset — the second
    // open attempt must 409, enforced by the database, not just the route.
    uniqueIndex("job_cards_active_asset_unique")
      .on(t.assetId)
      .where(sql`${t.status} in ('open', 'in_progress', 'on_hold') and ${t.assetId} is not null`),
  ],
);

export const insertJobCardSchema = createInsertSchema(jobCardsTable, {
  status: z.enum(JOB_CARD_STATUSES),
  payType: z.enum(["customer", "warranty", "goodwill", "rectify"]),
  checklist: z.array(z.object({ label: z.string(), done: z.boolean() })),
}).omit({ dealerId: true, id: true, createdAt: true, startedAt: true, completedAt: true });
export type InsertJobCard = z.infer<typeof insertJobCardSchema>;
export type JobCard = typeof jobCardsTable.$inferSelect;

// ---------------------------------------------------------------------------
// Job card part lines (issue decrements stock, return restocks)
// ---------------------------------------------------------------------------

export const jobCardPartsTable = pgTable("job_card_parts", {
  id: serial("id").primaryKey(),
  dealerId: integer("dealer_id").notNull(),
  jobCardId: integer("job_card_id")
    .notNull()
    .references(() => jobCardsTable.id, { onDelete: "cascade" }),
  partId: integer("part_id")
    .notNull()
    .references(() => partsTable.id),
  partName: text("part_name").notNull(),
  kind: text("kind").notNull().default("issue"),
  quantity: integer("quantity").notNull(),
  unitPrice: doublePrecision("unit_price").notNull().default(0),
  unitCost: doublePrecision("unit_cost").notNull().default(0),
  backordered: boolean("backordered").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertJobCardPartSchema = createInsertSchema(
  jobCardPartsTable,
).omit({ dealerId: true, id: true, createdAt: true });
export type InsertJobCardPart = z.infer<typeof insertJobCardPartSchema>;
export type JobCardPart = typeof jobCardPartsTable.$inferSelect;

// ---------------------------------------------------------------------------
// Warranty / AMC coverage per vehicle
// ---------------------------------------------------------------------------

export const coveragePlansTable = pgTable("coverage_plans", {
  id: serial("id").primaryKey(),
  dealerId: integer("dealer_id").notNull(),
  customerId: integer("customer_id"),
  customerName: text("customer_name"),
  vehicleInfo: text("vehicle_info").notNull(),
  type: text("type").notNull().default("warranty"),
  provider: text("provider"),
  startDate: date("start_date", { mode: "string" }).notNull(),
  endDate: date("end_date", { mode: "string" }).notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertCoveragePlanSchema = createInsertSchema(
  coveragePlansTable,
).omit({ dealerId: true, id: true, createdAt: true });
export type InsertCoveragePlan = z.infer<typeof insertCoveragePlanSchema>;
export type CoveragePlan = typeof coveragePlansTable.$inferSelect;

// ---------------------------------------------------------------------------
// Service invoices (roll-up of a job card's parts + labour)
// ---------------------------------------------------------------------------

export const serviceInvoicesTable = pgTable("service_invoices", {
  id: serial("id").primaryKey(),
  dealerId: integer("dealer_id").notNull(),
  serviceOrderId: integer("service_order_id").notNull(),
  jobCardId: integer("job_card_id").notNull(),
  customerId: integer("customer_id"),
  customerName: text("customer_name"),
  vehicleInfo: text("vehicle_info").notNull(),
  partsTotal: doublePrecision("parts_total").notNull().default(0),
  laborTotal: doublePrecision("labor_total").notNull().default(0),
  tax: doublePrecision("tax").notNull().default(0),
  total: doublePrecision("total").notNull().default(0),
  status: text("status").notNull().default("issued"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertServiceInvoiceSchema = createInsertSchema(
  serviceInvoicesTable,
).omit({ dealerId: true, id: true, createdAt: true });
export type InsertServiceInvoice = z.infer<typeof insertServiceInvoiceSchema>;
export type ServiceInvoice = typeof serviceInvoicesTable.$inferSelect;
