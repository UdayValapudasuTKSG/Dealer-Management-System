-- Daily technician timesheets and immutable invoice labour snapshots.
-- Additive and safe to run repeatedly. No existing timer data is backfilled:
-- job_cards.timer_seconds is cumulative, not a daily actual.

CREATE TABLE IF NOT EXISTS technician_timesheet_entries (
  id serial PRIMARY KEY,
  dealer_id integer NOT NULL,
  technician_user_id integer NOT NULL REFERENCES users(id),
  work_date date NOT NULL,
  job_card_id integer REFERENCES job_cards(id) ON DELETE SET NULL,
  duration_minutes integer NOT NULL,
  note text,
  source text NOT NULL DEFAULT 'manual',
  created_by_user_id integer,
  updated_by_user_id integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS technician_timesheet_dealer_day_idx
  ON technician_timesheet_entries (dealer_id, work_date, technician_user_id);

CREATE UNIQUE INDEX IF NOT EXISTS technician_timesheet_job_day_unique
  ON technician_timesheet_entries (dealer_id, technician_user_id, work_date, job_card_id)
  WHERE job_card_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS technician_daily_availability (
  id serial PRIMARY KEY,
  dealer_id integer NOT NULL,
  technician_user_id integer NOT NULL REFERENCES users(id),
  work_date date NOT NULL,
  available_hours double precision NOT NULL,
  updated_by_user_id integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT technician_daily_availability_unique
    UNIQUE (dealer_id, technician_user_id, work_date)
);

ALTER TABLE service_invoices
  ADD COLUMN IF NOT EXISTS invoiced_labor_hours double precision;
ALTER TABLE service_invoices
  ADD COLUMN IF NOT EXISTS invoiced_labor_hours_source text NOT NULL DEFAULT 'historical_unknown';
ALTER TABLE service_invoices
  ADD COLUMN IF NOT EXISTS issued_at timestamptz;
