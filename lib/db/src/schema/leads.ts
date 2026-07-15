import { sql } from "drizzle-orm";
import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

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

export const LEAD_PRIORITIES = ["high", "medium", "low"] as const;
export type LeadPriority = (typeof LEAD_PRIORITIES)[number];

export type LeadAttachment = { name: string; url: string };

export const leadsTable = pgTable("leads", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email"),
  phone: text("phone"),
  channel: text("channel").notNull().default("web"),
  source: text("source").notNull().default("website"),
  priority: text("priority").notNull().default("medium"),
  phase: text("phase").notNull().default("aware"),
  status: text("status").notNull().default("new"),
  customerId: integer("customer_id"),
  interestedVehicleId: integer("interested_vehicle_id"),
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
  availability: text("availability"),
  purchaseType: text("purchase_type"),
  attachments: jsonb("attachments")
    .$type<LeadAttachment[]>()
    .notNull()
    .default([]),
  aiScore: integer("ai_score").notNull().default(50),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertLeadSchema = createInsertSchema(leadsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertLead = z.infer<typeof insertLeadSchema>;
export type Lead = typeof leadsTable.$inferSelect;
