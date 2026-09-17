-- Preserve manual correction/ledger supersession when a service-order delete
-- cascades to job_cards and the live job_card_id FK is set NULL.
-- This records only the still-linked association; it never fabricates an id
-- for rows whose card was already deleted, and never backfills any hours.

BEGIN;

CREATE TABLE IF NOT EXISTS aura_schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE technician_timesheet_entries
  ADD COLUMN IF NOT EXISTS original_job_card_id integer;

-- Existing live links are safe historical evidence of the original card.
-- A prior FK-nullified row deliberately remains unknown rather than guessed.
UPDATE technician_timesheet_entries
   SET original_job_card_id = job_card_id
 WHERE original_job_card_id IS NULL
   AND job_card_id IS NOT NULL;

-- The server always writes this value, but an FK action is a database UPDATE
-- outside that application code. Preserve the old live id before ON DELETE
-- SET NULL can discard it, including for direct SQL/card deletes. Existing
-- original ids are immutable and are never replaced.
CREATE OR REPLACE FUNCTION technician_timesheet_entry_preserve_original_job_card()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.original_job_card_id IS NULL AND NEW.job_card_id IS NOT NULL THEN
      NEW.original_job_card_id := NEW.job_card_id;
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.original_job_card_id IS NOT NULL THEN
    NEW.original_job_card_id := OLD.original_job_card_id;
  ELSIF OLD.job_card_id IS NOT NULL THEN
    NEW.original_job_card_id := OLD.job_card_id;
  ELSIF NEW.original_job_card_id IS NULL AND NEW.job_card_id IS NOT NULL THEN
    NEW.original_job_card_id := NEW.job_card_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS technician_timesheet_entry_preserve_original_job_card_trigger
  ON technician_timesheet_entries;
CREATE TRIGGER technician_timesheet_entry_preserve_original_job_card_trigger
  BEFORE INSERT OR UPDATE OF job_card_id, original_job_card_id
  ON technician_timesheet_entries
  FOR EACH ROW
  EXECUTE FUNCTION technician_timesheet_entry_preserve_original_job_card();

CREATE INDEX IF NOT EXISTS technician_timesheet_original_job_day_idx
  ON technician_timesheet_entries
    (dealer_id, technician_user_id, work_date, original_job_card_id);

INSERT INTO aura_schema_migrations(name)
VALUES ('2026-10-01-technician-timesheet-original-job-card')
ON CONFLICT (name) DO NOTHING;

COMMIT;