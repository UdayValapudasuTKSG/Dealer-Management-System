import {
  check,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Append-only, database-generated timer transition ledger.
 *
 * This intentionally is not a timesheet: each timer transition is preserved
 * with the dealership timezone and technician identity as they were when the
 * transition happened. A worked interval is the `start`/`resume` entry paired
 * with its following `pause`/`status_stopped`/`reassigned`/`completed` entry.
 * `legacy_timer_stopped` is audit-only: it proves a pre-deployment running
 * timer stopped but intentionally contains no historical duration.
 * No existing job-card timer value is copied into this table.
 */
export const technicianWorkSegmentLedgerTable = pgTable(
  "technician_work_segment_ledger",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    // Deliberately no FK: a historical ledger entry must survive job-card or
    // user cleanup, and its id/name fields are immutable snapshots.
    jobCardId: integer("job_card_id").notNull(),
    technicianUserId: integer("technician_user_id"),
    technicianNameSnapshot: text("technician_name_snapshot"),
    previousTechnicianUserId: integer("previous_technician_user_id"),
    previousTechnicianNameSnapshot: text("previous_technician_name_snapshot"),
    nextTechnicianUserId: integer("next_technician_user_id"),
    nextTechnicianNameSnapshot: text("next_technician_name_snapshot"),
    dealerTimezoneSnapshot: text("dealer_timezone_snapshot").notNull(),
    eventType: text("event_type").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    // The original timer boundary, never a synthesized/backfilled boundary.
    segmentStartedAt: timestamp("segment_started_at", { withTimezone: true }),
    segmentEndedAt: timestamp("segment_ended_at", { withTimezone: true }),
    durationSeconds: integer("duration_seconds"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    source: text("source").notNull().default("job_cards_trigger"),
  },
  (t) => [
    check(
      "technician_work_segment_ledger_event_type_check",
      sql`${t.eventType} in ('start', 'pause', 'resume', 'status_stopped', 'completed', 'reassigned', 'legacy_timer_stopped')`,
    ),
    index("technician_work_segment_ledger_job_occurred_idx").on(
      t.dealerId,
      t.jobCardId,
      t.occurredAt,
    ),
    index("technician_work_segment_ledger_technician_occurred_idx").on(
      t.dealerId,
      t.technicianUserId,
      t.occurredAt,
    ),
  ],
);

export type TechnicianWorkSegmentLedgerEntry =
  typeof technicianWorkSegmentLedgerTable.$inferSelect;