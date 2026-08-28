-- Server writes enforce phone snapshots for all new service orders; existing
-- historical rows remain readable when no trustworthy backfill exists.
ALTER TABLE service_orders
  ADD CONSTRAINT service_orders_new_phone_snapshot_chk
  CHECK (customer_phone_snapshot IS NULL OR length(regexp_replace(customer_phone_snapshot, '\\D', '', 'g')) BETWEEN 7 AND 15)
  NOT VALID;

-- Reconcile historical quote races before asserting one revision and one
-- current revision per dealer/lead. Latest row wins deterministically.
WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY dealer_id, lead_id, version ORDER BY created_at DESC, id DESC
  ) AS rn FROM quotes
)
UPDATE quotes SET status = 'superseded'
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
WITH ranked_current AS (
  SELECT id, row_number() OVER (
    PARTITION BY dealer_id, lead_id ORDER BY version DESC, created_at DESC, id DESC
  ) AS rn FROM quotes WHERE status = 'current'
)
UPDATE quotes SET status = 'superseded'
WHERE id IN (SELECT id FROM ranked_current WHERE rn > 1);
CREATE UNIQUE INDEX IF NOT EXISTS quotes_dealer_lead_version_uq
  ON quotes (dealer_id, lead_id, version);
CREATE UNIQUE INDEX IF NOT EXISTS quotes_one_current_per_lead_uq
  ON quotes (dealer_id, lead_id) WHERE status = 'current';

ALTER TABLE deals ADD COLUMN IF NOT EXISTS quote_id integer;
CREATE INDEX IF NOT EXISTS deals_dealer_quote_idx ON deals (dealer_id, quote_id);