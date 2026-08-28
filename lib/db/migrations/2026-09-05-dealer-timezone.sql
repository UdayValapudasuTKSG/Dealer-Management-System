-- Task 266: dealership-level timezone setting.
-- Every dealership renders dates/times, calendar boundaries, schedules and
-- generated documents in its own IANA timezone. Existing dealerships keep
-- the historical Guyana behavior via the default backfill.
BEGIN;

ALTER TABLE dealers
  ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'America/Guyana';

COMMIT;
