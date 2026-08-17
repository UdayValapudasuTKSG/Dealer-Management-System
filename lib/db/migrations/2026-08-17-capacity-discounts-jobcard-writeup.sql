-- Capacity planning, quote discounts, and mandatory job-card completion write-up.
-- Additive; safe to re-run (IF NOT EXISTS everywhere).

CREATE TABLE IF NOT EXISTS capacity_blocks (
  id serial PRIMARY KEY,
  dealer_id integer NOT NULL REFERENCES dealers(id),
  kind text NOT NULL,
  ref_id integer NOT NULL,
  date date NOT NULL,
  reason text,
  created_by text,
  created_at timestamp DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS capacity_blocks_unique_idx
  ON capacity_blocks (dealer_id, kind, ref_id, date);

ALTER TABLE quotes ADD COLUMN IF NOT EXISTS discount_amount double precision DEFAULT 0 NOT NULL;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS discount_status text DEFAULT 'none' NOT NULL;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS discount_requested_amount double precision;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS discount_reason text;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS discount_requested_by text;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS discount_gate_id integer;

ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS service_analysis text;
ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS work_performed text;

-- Hour-window capacity blocks + handover form overrides
ALTER TABLE capacity_blocks ADD COLUMN IF NOT EXISTS start_hour integer;
ALTER TABLE capacity_blocks ADD COLUMN IF NOT EXISTS end_hour integer;
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS handover_overrides jsonb DEFAULT '{}'::jsonb NOT NULL;
