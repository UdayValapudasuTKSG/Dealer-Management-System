-- Task #253: immutable workshop contact snapshot and attributed work log.
-- Safe to run repeatedly and additive only.
ALTER TABLE job_cards
  ADD COLUMN IF NOT EXISTS customer_phone_snapshot text;

CREATE TABLE IF NOT EXISTS job_card_technician_notes (
  id serial PRIMARY KEY,
  dealer_id integer NOT NULL,
  job_card_id integer NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,
  body text NOT NULL,
  author_user_id integer,
  author_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS job_card_technician_notes_card_created_idx
  ON job_card_technician_notes (dealer_id, job_card_id, created_at);