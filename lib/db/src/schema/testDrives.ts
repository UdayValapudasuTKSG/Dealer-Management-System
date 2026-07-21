import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { leadsTable } from "./leads";

/**
 * First-class test-drive records (spec R1 / V1 2.15). Each booking — whether
 * self-booked via the public invite link or booked by staff — creates one
 * durable row with its own lifecycle, instead of living only as loose lead
 * columns. The lead columns (testDriveAt/Branch/Licence/Waiver) stay in sync
 * for the pipeline UI; this table is the system of record for history.
 */
export const TEST_DRIVE_STATUSES = [
  "scheduled",
  "completed",
  "no_show",
  "cancelled",
] as const;
export type TestDriveStatus = (typeof TEST_DRIVE_STATUSES)[number];

export const testDrivesTable = pgTable(
  "test_drives",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    leadId: integer("lead_id")
      .notNull()
      .references(() => leadsTable.id, { onDelete: "cascade" }),
    vehicleId: integer("vehicle_id"),
    customerId: integer("customer_id"),
    status: text("status").notNull().default("scheduled"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    branch: text("branch"),
    licenceNumber: text("licence_number"),
    waiverAccepted: boolean("waiver_accepted").notNull().default(false),
    /** How the booking was made: self_service | staff | migration. */
    bookedVia: text("booked_via").notNull().default("staff"),
    outcomeNotes: text("outcome_notes"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("test_drives_dealer_lead_idx").on(t.dealerId, t.leadId),
    index("test_drives_dealer_status_idx").on(t.dealerId, t.status),
  ],
);

export const insertTestDriveSchema = createInsertSchema(testDrivesTable, {
  status: z.enum(TEST_DRIVE_STATUSES),
}).omit({ dealerId: true, id: true, createdAt: true });
export type InsertTestDrive = z.infer<typeof insertTestDriveSchema>;
export type TestDrive = typeof testDrivesTable.$inferSelect;
