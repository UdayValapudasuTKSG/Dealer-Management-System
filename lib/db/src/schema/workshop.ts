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

/** Formal PO lifecycle: draft → ordered → partially_received → received (+ cancelled). */
export const PURCHASE_ORDER_STATUSES = [
  "draft",
  "ordered",
  "partially_received",
  "received",
  "cancelled",
] as const;
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

/** Multi-day rollover approval state (FR-SR-06): dual sign-off required. */
export const ROLLOVER_STATUSES = ["none", "pending", "approved"] as const;
export type RolloverStatus = (typeof ROLLOVER_STATUSES)[number];

/** Late-service surcharge decision state (FR-SR-07). */
export const SURCHARGE_STATUSES = [
  "none",
  "suggested",
  "applied",
  "waived",
] as const;
export type SurchargeStatus = (typeof SURCHARGE_STATUSES)[number];

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
    // Mandatory completion write-up: the technician must record their
    // analysis of the service and what work was performed before the card
    // can be marked completed (enforced in the update route).
    serviceAnalysis: text("service_analysis"),
    workPerformed: text("work_performed"),
    // Multi-day rollover (FR-SR-06): carrying an incomplete job to another
    // day needs BOTH the Service Manager and the assigned Technician to sign
    // off. Approvals record who/when; on the second approval the card's
    // scheduled date moves to rolloverToDate.
    rolloverStatus: text("rollover_status").notNull().default("none"),
    rolloverToDate: date("rollover_to_date", { mode: "string" }),
    rolloverReason: text("rollover_reason"),
    rolloverRequestedBy: text("rollover_requested_by"),
    rolloverRequestedAt: timestamp("rollover_requested_at", {
      withTimezone: true,
    }),
    rolloverManagerApprovedBy: text("rollover_manager_approved_by"),
    rolloverManagerApprovedAt: timestamp("rollover_manager_approved_at", {
      withTimezone: true,
    }),
    rolloverTechApprovedBy: text("rollover_tech_approved_by"),
    rolloverTechApprovedAt: timestamp("rollover_tech_approved_at", {
      withTimezone: true,
    }),
    // Late-service surcharge (FR-SR-07): intake odometer past the dealer's
    // service interval flags a configurable flat surcharge; staff apply or
    // waive it, and an applied surcharge flows into the invoice total.
    surchargeStatus: text("surcharge_status").notNull().default("none"),
    surchargeAmount: doublePrecision("surcharge_amount").notNull().default(0),
    surchargeOverKm: integer("surcharge_over_km"),
    surchargeDecidedBy: text("surcharge_decided_by"),
    surchargeDecidedAt: timestamp("surcharge_decided_at", {
      withTimezone: true,
    }),
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
}).omit({
  dealerId: true,
  id: true,
  createdAt: true,
  startedAt: true,
  completedAt: true,
  rolloverStatus: true,
  rolloverToDate: true,
  rolloverReason: true,
  rolloverRequestedBy: true,
  rolloverRequestedAt: true,
  rolloverManagerApprovedBy: true,
  rolloverManagerApprovedAt: true,
  rolloverTechApprovedBy: true,
  rolloverTechApprovedAt: true,
  surchargeStatus: true,
  surchargeAmount: true,
  surchargeOverKm: true,
  surchargeDecidedBy: true,
  surchargeDecidedAt: true,
});
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

export const partCreditNotesTable = pgTable("part_credit_notes", {
  id: serial("id").primaryKey(),
  dealerId: integer("dealer_id").notNull(),
  jobCardId: integer("job_card_id")
    .notNull()
    .references(() => jobCardsTable.id, { onDelete: "cascade" }),
  /** The originating issue line being credited. */
  jobCardPartId: integer("job_card_part_id")
    .notNull()
    .references(() => jobCardPartsTable.id),
  partId: integer("part_id")
    .notNull()
    .references(() => partsTable.id),
  partName: text("part_name").notNull(),
  quantity: integer("quantity").notNull(),
  unitPrice: doublePrecision("unit_price").notNull().default(0),
  amount: doublePrecision("amount").notNull().default(0),
  reason: text("reason").notNull(),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
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

/** Discount approval state on a service invoice (FR-SR-08). */
export const DISCOUNT_STATUSES = [
  "none",
  "pending",
  "approved",
  "rejected",
] as const;
export type DiscountStatus = (typeof DISCOUNT_STATUSES)[number];

/** Post-issue adjustment entry — the only sanctioned way totals change. */
export type InvoiceAdjustment = {
  amount: number;
  reason: string;
  by: string;
  at: string;
};

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
  surchargeTotal: doublePrecision("surcharge_total").notNull().default(0),
  tax: doublePrecision("tax").notNull().default(0),
  // Discount workflow (FR-SR-08): any discount needs Service Manager /
  // Management approval before the discounted total is final.
  discountTotal: doublePrecision("discount_total").notNull().default(0),
  discountStatus: text("discount_status").notNull().default("none"),
  discountRequestedAmount: doublePrecision("discount_requested_amount"),
  discountReason: text("discount_reason"),
  discountRequestedBy: text("discount_requested_by"),
  discountRequestedAt: timestamp("discount_requested_at", {
    withTimezone: true,
  }),
  discountDecidedBy: text("discount_decided_by"),
  discountDecidedAt: timestamp("discount_decided_at", { withTimezone: true }),
  total: doublePrecision("total").notNull().default(0),
  status: text("status").notNull().default("issued"),
  // Totals lock at issue (FR-SR-09); later changes append adjustments.
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  adjustments: jsonb("adjustments")
    .$type<InvoiceAdjustment[]>()
    .notNull()
    .default([]),
  // Signed receipt copy collected & filed acknowledgement (FR-SR-10).
  signedCopyFiledBy: text("signed_copy_filed_by"),
  signedCopyFiledAt: timestamp("signed_copy_filed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertServiceInvoiceSchema = createInsertSchema(
  serviceInvoicesTable,
).omit({ dealerId: true, id: true, createdAt: true });
export type InsertServiceInvoice = z.infer<typeof insertServiceInvoiceSchema>;
export type ServiceInvoice = typeof serviceInvoicesTable.$inferSelect;

// ---------------------------------------------------------------------------
// Per-dealer service settings (interval + late-service surcharge fee)
// ---------------------------------------------------------------------------

/** Defaults: 5,000 km service interval; GYD 10,000 flat late surcharge. */
export const DEFAULT_SERVICE_INTERVAL_KM = 5000;
export const DEFAULT_LATE_SURCHARGE_FEE = 10000;
/** Capacity planning defaults: 2h per vehicle, 8h technician workday. */
export const DEFAULT_JOB_HOURS = 2;
export const DEFAULT_TECH_WORK_HOURS_PER_DAY = 8;

/** FR-COM-03: management scheduled-services summary cadence options. */
export const SERVICE_SUMMARY_CADENCES = ["daily", "weekly", "off"] as const;
export type ServiceSummaryCadence = (typeof SERVICE_SUMMARY_CADENCES)[number];
export const DEFAULT_SERVICE_SUMMARY_CADENCE: ServiceSummaryCadence = "daily";

export const dealerServiceSettingsTable = pgTable(
  "dealer_service_settings",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    serviceIntervalKm: integer("service_interval_km")
      .notNull()
      .default(DEFAULT_SERVICE_INTERVAL_KM),
    lateSurchargeFee: doublePrecision("late_surcharge_fee")
      .notNull()
      .default(DEFAULT_LATE_SURCHARGE_FEE),
    /** FR-COM-03: cadence of the management scheduled-services summary email. */
    summaryCadence: text("summary_cadence").notNull().default("daily"),
    /** GM-configurable capacity planning: default booked hours per vehicle. */
    defaultJobHours: doublePrecision("default_job_hours")
      .notNull()
      .default(DEFAULT_JOB_HOURS),
    /** GM-configurable capacity planning: technician working hours per day. */
    techWorkHoursPerDay: doublePrecision("tech_work_hours_per_day")
      .notNull()
      .default(DEFAULT_TECH_WORK_HOURS_PER_DAY),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("dealer_service_settings_dealer_unique").on(t.dealerId)],
);

export type DealerServiceSettings =
  typeof dealerServiceSettingsTable.$inferSelect;

export type PartCreditNote = typeof partCreditNotesTable.$inferSelect;

export const purchaseOrdersTable = pgTable("purchase_orders", {
  id: serial("id").primaryKey(),
  dealerId: integer("dealer_id").notNull(),
  supplierId: integer("supplier_id").references(() => suppliersTable.id),
  status: text("status").notNull().default("draft"),
  expectedDate: date("expected_date", { mode: "string" }),
  reference: text("reference"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type PurchaseOrder = typeof purchaseOrdersTable.$inferSelect;

export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];

export const purchaseOrderLinesTable = pgTable("purchase_order_lines", {
  id: serial("id").primaryKey(),
  dealerId: integer("dealer_id").notNull(),
  purchaseOrderId: integer("purchase_order_id")
    .notNull()
    .references(() => purchaseOrdersTable.id, { onDelete: "cascade" }),
  partId: integer("part_id")
    .notNull()
    .references(() => partsTable.id),
  partName: text("part_name").notNull(),
  quantity: integer("quantity").notNull(),
  qtyReceived: integer("qty_received").notNull().default(0),
  unitCost: doublePrecision("unit_cost").notNull().default(0),
  /** Originating job card (backorder link) — received parts trace back here. */
  jobCardId: integer("job_card_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type PurchaseOrderLine = typeof purchaseOrderLinesTable.$inferSelect;
