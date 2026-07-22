import { sql } from "drizzle-orm";
import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  jsonb,
  boolean,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { divisionsTable } from "./divisions";

export const LEAD_SOURCES = [
  "website",
  "walk_in",
  "phone",
  "facebook",
  "instagram",
  "whatsapp",
  "referral",
] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

/** Canonical lead phase machine (NC-3): new → contacted → qualified → proposal → negotiation → won | lost. */
export const LEAD_PHASES = [
  "new",
  "contacted",
  "qualified",
  "proposal",
  "negotiation",
  "won",
  "lost",
] as const;
export type LeadPhase = (typeof LEAD_PHASES)[number];

export const LEAD_PRIORITIES = ["high", "medium", "low"] as const;
export type LeadPriority = (typeof LEAD_PRIORITIES)[number];

export type LeadAttachment = { name: string; url: string };

export const leadsTable = pgTable("leads", {
  id: serial("id").primaryKey(),
  dealerId: integer("dealer_id").notNull(),
  divisionId: integer("division_id").references(() => divisionsTable.id),
  name: text("name").notNull(),
  email: text("email"),
  phone: text("phone"),
  channel: text("channel").notNull().default("web"),
  source: text("source").notNull().default("website"),
  // Social sub-platform (facebook/instagram/tiktok/…) when source is social.
  sourceDetail: text("source_detail"),
  priority: text("priority").notNull().default("medium"),
  phase: text("phase").notNull().default("new"),
  status: text("status").notNull().default("new"),
  customerId: integer("customer_id"),
  interestedVehicleId: integer("interested_vehicle_id"),
  // Locked at reservation (Pre-Book) — distinct from the interested model(s).
  selectedModel: text("selected_model"),
  variant: text("variant"),
  color: text("color"),
  preferredBranch: text("preferred_branch"),
  assignedTo: text("assigned_to"),
  ownerUserId: integer("owner_user_id"),
  testDriveAt: timestamp("test_drive_at", { withTimezone: true }),
  testDriveBranch: text("test_drive_branch"),
  // Public self-service booking link token (emailed to the customer).
  testDriveToken: text("test_drive_token")
    .notNull()
    .unique()
    .default(sql`gen_random_uuid()`),
  // Test-drive compliance: driver's licence + signed waiver (required before booking).
  testDriveLicence: text("test_drive_licence"),
  testDriveWaiver: boolean("test_drive_waiver").notNull().default(false),
  availability: text("availability"),
  purchaseType: text("purchase_type"),
  attachments: jsonb("attachments")
    .$type<LeadAttachment[]>()
    .notNull()
    .default([]),
  aiScore: integer("ai_score").notNull().default(50),
  notes: text("notes"),
  // Salesforce-parity record fields
  company: text("company"),
  title: text("title"),
  isRetailCustomer: boolean("is_retail_customer").notNull().default(false),
  quotationSent: boolean("quotation_sent").notNull().default(false),
  reservationFeePaid: boolean("reservation_fee_paid").notNull().default(false),
  reservationComments: text("reservation_comments"),
  financingQualified: boolean("financing_qualified").notNull().default(false),
  contactedDate: timestamp("contacted_date", { withTimezone: true }),
  revisitIn3Months: boolean("revisit_in_3_months").notNull().default(false),
  closureReason: text("closure_reason"),
  purchaseIntent: text("purchase_intent"),
  keyInterestDriver: text("key_interest_driver"),
  budgetFinancing: text("budget_financing"),
  description: text("description"),
  address: text("address"),
  // Stamped whenever the lead advances to a new pipeline stage (powers days-in-stage / SLA).
  stageEnteredAt: timestamp("stage_entered_at", { withTimezone: true }),
  // Soft delete (R4.8): rows are never hard-removed from the data plane.
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: text("deleted_by"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertLeadSchema = createInsertSchema(leadsTable, {
  phase: z.enum(LEAD_PHASES),
}).omit({ dealerId: true,
  id: true,
  createdAt: true,
});
export type InsertLead = z.infer<typeof insertLeadSchema>;
export type Lead = typeof leadsTable.$inferSelect;
