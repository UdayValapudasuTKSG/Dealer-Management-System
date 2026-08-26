-- Capacity blocks: allow multiple hour windows per resource per day.
-- Replaces the single-row-per-day unique index with:
--   * one full-day block max per resource/day
--   * unique (non-duplicate) hour windows per resource/day; overlap between
--     different windows is enforced by the API inside a transaction.
-- Idempotent; safe to re-run.

DROP INDEX IF EXISTS capacity_blocks_unique_idx;
DROP INDEX IF EXISTS capacity_blocks_unique;

CREATE UNIQUE INDEX IF NOT EXISTS capacity_blocks_fullday_unique
  ON capacity_blocks (dealer_id, kind, ref_id, date)
  WHERE start_hour IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS capacity_blocks_window_unique
  ON capacity_blocks (dealer_id, kind, ref_id, date, start_hour, end_hour)
  WHERE start_hour IS NOT NULL;
