import {
  pgTable,
  serial,
  integer,
  doublePrecision,
  date,
  timestamp,
  text,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { jobCardsTable } from "./workshop";
import { usersTable } from "./users";

/**
 * A manually entered, daily technician actual.  The entry is deliberately
 * not derived from the job-card timer: timerSeconds is cumulative over the
 * life of a card and cannot be presented as a particular day's actual.
 */
export const technicianTimesheetEntriesTable = pgTable(
  "technician_timesheet_entries",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    technicianUserId: integer("technician_user_id")
      .notNull()
      .references(() => usersTable.id),
    workDate: date("work_date", { mode: "string" }).notNull(),
    jobCardId: integer("job_card_id").references(() => jobCardsTable.id, {
      onDelete: "set null",
    }),
    durationMinutes: integer("duration_minutes").notNull(),
    note: text("note"),
    source: text("source").notNull().default("manual"),
    createdByUserId: integer("created_by_user_id"),
    updatedByUserId: integer("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // One manual row per technician/card/dealer day prevents a job from being
    // silently double-counted. Non-job rows intentionally remain multi-row.
    uniqueIndex("technician_timesheet_job_day_unique")
      .on(t.dealerId, t.technicianUserId, t.workDate, t.jobCardId)
      .where(sql`${t.jobCardId} is not null`),
    index("technician_timesheet_dealer_day_idx").on(
      t.dealerId,
      t.workDate,
      t.technicianUserId,
    ),
  ],
);

export const insertTechnicianTimesheetEntrySchema = createInsertSchema(
  technicianTimesheetEntriesTable,
  {
    durationMinutes: z.number().int().positive().max(24 * 60),
    workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    note: z.string().trim().max(2000).nullable().optional(),
  },
).omit({
  id: true,
  dealerId: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertTechnicianTimesheetEntry = z.infer<
  typeof insertTechnicianTimesheetEntrySchema
>;
export type TechnicianTimesheetEntry =
  typeof technicianTimesheetEntriesTable.$inferSelect;

/** Per-technician/day availability override. Missing row = dealer setting. */
export const technicianDailyAvailabilityTable = pgTable(
  "technician_daily_availability",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    technicianUserId: integer("technician_user_id")
      .notNull()
      .references(() => usersTable.id),
    workDate: date("work_date", { mode: "string" }).notNull(),
    availableHours: doublePrecision("available_hours").notNull(),
    updatedByUserId: integer("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("technician_daily_availability_unique").on(
      t.dealerId,
      t.technicianUserId,
      t.workDate,
    ),
  ],
);

export type TechnicianDailyAvailability =
  typeof technicianDailyAvailabilityTable.$inferSelect;
