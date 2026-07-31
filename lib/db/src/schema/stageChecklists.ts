import {
  pgTable,
  serial,
  text,
  integer,
  jsonb,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { dealersTable } from "./dealers";

/**
 * Per-dealer, per-stage advance-gate checklists. VERSIONED: every save
 * inserts a new row with version+1; the highest version is active. Historic
 * versions are never rewritten, so past advances keep their context.
 */
export const CHECKLIST_STAGES = [
  "qualified",
  "test_drive",
  "proposal",
  "negotiation",
  "sold",
] as const;
export type ChecklistStage = (typeof CHECKLIST_STAGES)[number];

/** Built-in automated checks the gate knows how to evaluate. */
export const CHECKLIST_ITEM_KEYS = [
  "call_logged",
  "contact_details",
  "vehicle_selected",
  "budget_discussed",
  "test_drive_booked",
  "licence_on_file",
  "waiver_signed",
  "vehicle_available",
  "test_drive_completed",
  "quote_sent",
  "deal_created",
  "deal_exists",
  "selected_model",
  "reservation_fee",
  "primary_contact",
  "vin_allocated",
  "recall_clear",
  "deposit_taken",
  "finance_approved",
] as const;
export type ChecklistItemKey = (typeof CHECKLIST_ITEM_KEYS)[number];

export const checklistItemSchema = z.object({
  key: z.enum(CHECKLIST_ITEM_KEYS),
  label: z.string().min(1).max(200),
  enabled: z.boolean(),
});
export type StageChecklistItem = z.infer<typeof checklistItemSchema>;

export const stageChecklistsTable = pgTable(
  "stage_checklists",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id")
      .notNull()
      .references(() => dealersTable.id, { onDelete: "cascade" }),
    stage: text("stage").notNull(),
    version: integer("version").notNull().default(1),
    items: jsonb("items").$type<StageChecklistItem[]>().notNull().default([]),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("stage_checklists_dealer_stage_version_idx").on(
      t.dealerId,
      t.stage,
      t.version,
    ),
  ],
);

export const insertStageChecklistSchema = createInsertSchema(
  stageChecklistsTable,
  { stage: z.enum(CHECKLIST_STAGES), items: z.array(checklistItemSchema) },
).omit({ id: true, createdAt: true });
export type InsertStageChecklist = z.infer<typeof insertStageChecklistSchema>;
export type StageChecklist = typeof stageChecklistsTable.$inferSelect;

/** Defaults matching the previously hardcoded gate behavior. */
export const DEFAULT_STAGE_CHECKLISTS: Record<ChecklistStage, StageChecklistItem[]> =
  {
    qualified: [
      { key: "contact_details", label: "Contact details (email or phone) captured", enabled: true },
      { key: "vehicle_selected", label: "Vehicle of interest selected", enabled: true },
      { key: "budget_discussed", label: "Budget / financing discussed", enabled: true },
    ],
    test_drive: [
      { key: "call_logged", label: "At least one call logged with an outcome", enabled: true },
      { key: "test_drive_booked", label: "Test-drive slot booked", enabled: false },
      { key: "licence_on_file", label: "Driver's licence number on file", enabled: false },
      { key: "waiver_signed", label: "Test-drive waiver signed", enabled: false },
      { key: "vehicle_available", label: "Interested vehicle is available for a drive", enabled: false },
    ],
    proposal: [
      { key: "test_drive_completed", label: "Test drive completed (or explicitly booked)", enabled: false },
      { key: "quote_sent", label: "Quotation sent to the customer", enabled: true },
    ],
    negotiation: [
      { key: "quote_sent", label: "Quotation sent to the customer", enabled: false },
      { key: "deal_created", label: "Draft deal numbers entered (create a deal)", enabled: false },
    ],
    sold: [
      { key: "deal_exists", label: "A deal must exist before marking sold", enabled: true },
      { key: "vin_allocated", label: "Physical VIN allocated to the lead", enabled: true },
      { key: "recall_clear", label: "Allocated unit clear of recall/damage flags", enabled: true },
      { key: "selected_model", label: "Selected model locked on the lead", enabled: true },
      { key: "reservation_fee", label: "Reservation fee paid (or manager-approved waiver)", enabled: true },
      { key: "primary_contact", label: "Account linked with a primary contact", enabled: true },
      { key: "deposit_taken", label: "Deposit taken (deal deposit or reservation fee)", enabled: true },
      { key: "finance_approved", label: "Finance approved or cash purchase verified", enabled: true },
    ],
  };
