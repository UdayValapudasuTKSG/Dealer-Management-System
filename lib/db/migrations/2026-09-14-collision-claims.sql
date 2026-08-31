-- Collision claims module (Task 279): dealer-scoped claims riding on top of
-- existing repair orders, plus supplements and split-settlement ledgers.
-- Additive and idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS collision_claims (
  id SERIAL PRIMARY KEY,
  dealer_id INTEGER NOT NULL,
  service_order_id INTEGER NOT NULL,
  customer_id INTEGER,
  customer_name TEXT,
  vehicle_info TEXT NOT NULL,
  vehicle_id INTEGER,
  loss_date DATE NOT NULL,
  insurer_name TEXT NOT NULL,
  policy_number TEXT,
  claim_number TEXT,
  adjuster_name TEXT,
  adjuster_contact TEXT,
  severity TEXT NOT NULL DEFAULT 'moderate',
  damage_notes TEXT,
  damage_points JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'intake',
  initial_estimate DOUBLE PRECISION NOT NULL DEFAULT 0,
  contested_estimate DOUBLE PRECISION,
  approved_estimate DOUBLE PRECISION,
  deductible DOUBLE PRECISION NOT NULL DEFAULT 0,
  total_loss_value DOUBLE PRECISION,
  outcome_reason TEXT,
  paused_seconds INTEGER NOT NULL DEFAULT 0,
  paused_at TIMESTAMPTZ,
  service_invoice_id INTEGER,
  insurer_due DOUBLE PRECISION,
  deductible_due DOUBLE PRECISION,
  history JSONB NOT NULL DEFAULT '[]'::jsonb,
  closed_at TIMESTAMPTZ,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One claim per repair order. Historical data cannot conflict (new table),
-- but keep the guard idempotent regardless.
CREATE UNIQUE INDEX IF NOT EXISTS collision_claims_service_order_unique
  ON collision_claims (service_order_id);

-- Insurer claim numbers are unique per dealer + insurer when present.
CREATE UNIQUE INDEX IF NOT EXISTS collision_claims_insurer_claim_number_unique
  ON collision_claims (dealer_id, lower(insurer_name), lower(claim_number))
  WHERE claim_number IS NOT NULL AND claim_number <> '';

CREATE INDEX IF NOT EXISTS collision_claims_dealer_status_idx
  ON collision_claims (dealer_id, status);

CREATE TABLE IF NOT EXISTS collision_supplements (
  id SERIAL PRIMARY KEY,
  dealer_id INTEGER NOT NULL,
  claim_id INTEGER NOT NULL REFERENCES collision_claims(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  decision_note TEXT,
  requested_by TEXT,
  decided_by TEXT,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS collision_supplements_claim_idx
  ON collision_supplements (dealer_id, claim_id);

CREATE TABLE IF NOT EXISTS collision_settlements (
  id SERIAL PRIMARY KEY,
  dealer_id INTEGER NOT NULL,
  claim_id INTEGER NOT NULL REFERENCES collision_claims(id) ON DELETE CASCADE,
  payer TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  method TEXT,
  reference TEXT,
  recorded_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS collision_settlements_claim_idx
  ON collision_settlements (dealer_id, claim_id);
