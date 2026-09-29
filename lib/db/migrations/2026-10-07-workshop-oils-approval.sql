ALTER TABLE workshop_oil_requests
  ADD COLUMN IF NOT EXISTS approved_by integer,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE workshop_oil_requests DROP CONSTRAINT IF EXISTS workshop_oil_requests_status_ck;
ALTER TABLE workshop_oil_requests ADD CONSTRAINT workshop_oil_requests_status_ck
  CHECK (status IN ('requested','approved','partial','issued','cancelled'));