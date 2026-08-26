-- Job-card work timer: accumulated seconds + running-segment start.
-- Idempotent; additive only.
ALTER TABLE job_cards
  ADD COLUMN IF NOT EXISTS timer_seconds integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS timer_started_at timestamptz;
