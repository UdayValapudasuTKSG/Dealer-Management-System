-- Keep the booking/planned labour estimate separate from customer-facing
-- billable quote hours. NULL means no override, so existing cards retain their
-- planned hours without a production data backfill. Additive and safe to re-run.
ALTER TABLE job_cards
  ADD COLUMN IF NOT EXISTS quoted_labor_hours double precision;

-- These are no-ops for a newly added column, and make the migration safe for a
-- development database where an earlier draft used NOT NULL DEFAULT 0.
ALTER TABLE job_cards
  ALTER COLUMN quoted_labor_hours DROP DEFAULT,
  ALTER COLUMN quoted_labor_hours DROP NOT NULL;