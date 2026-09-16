-- Dealer-facing WIP metadata and immutable customer-cost approval versions.
-- Existing quoteApprovedAt values are intentionally not converted into an
-- approved version: legacy timestamps do not prove acceptance of a snapshot.

ALTER TABLE service_orders
  ADD COLUMN IF NOT EXISTS created_by_user_id integer,
  ADD COLUMN IF NOT EXISTS created_by_name text,
  ADD COLUMN IF NOT EXISTS created_origin text NOT NULL DEFAULT 'system';
-- The default only supports the ADD COLUMN operation. Rows that existed
-- before provenance capture must remain visibly legacy, never implied system.
UPDATE service_orders
SET created_origin = 'legacy_unknown'
WHERE created_by_user_id IS NULL
  AND created_by_name IS NULL
  AND created_origin = 'system';

ALTER TABLE job_cards
  ADD COLUMN IF NOT EXISTS waiting_reason text,
  ADD COLUMN IF NOT EXISTS waiting_history jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS next_action text,
  ADD COLUMN IF NOT EXISTS follow_up_date date,
  ADD COLUMN IF NOT EXISTS estimate_version integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS estimate_approved_version integer,
  ADD COLUMN IF NOT EXISTS estimate_approval_at timestamptz,
  ADD COLUMN IF NOT EXISTS estimate_approval_evidence jsonb,
  ADD COLUMN IF NOT EXISTS received_at timestamptz;

ALTER TABLE service_estimate_decisions
  ADD COLUMN IF NOT EXISTS estimate_version integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS decision_evidence jsonb;

ALTER TABLE service_invoices
  ADD COLUMN IF NOT EXISTS original_total double precision NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS balance double precision NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS customer_credit_balance double precision NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS credit_reconciliation_status text;
UPDATE service_invoices
SET original_total = total, balance = total
WHERE original_total = 0 AND balance = 0;
UPDATE service_invoices
SET balance = 0
WHERE status = 'paid';

ALTER TABLE job_cards DROP CONSTRAINT IF EXISTS job_cards_waiting_reason_check;
ALTER TABLE job_cards ADD CONSTRAINT job_cards_waiting_reason_check CHECK (
  waiting_reason IS NULL OR waiting_reason IN (
    'ordered_parts', 'technician_availability', 'diagnostics',
    'escalation_verdict', 'warranty_decision', 'customer_decision', 'other'
  )
);
ALTER TABLE service_orders DROP CONSTRAINT IF EXISTS service_orders_created_origin_check;
ALTER TABLE service_orders ADD CONSTRAINT service_orders_created_origin_check CHECK (
  created_origin IN ('staff', 'system', 'import', 'legacy_unknown')
);

CREATE INDEX IF NOT EXISTS job_cards_wip_idx
  ON job_cards (dealer_id, status, technician_user_id, received_at);
CREATE INDEX IF NOT EXISTS job_cards_waiting_idx
  ON job_cards (dealer_id, waiting_reason)
  WHERE waiting_reason IS NOT NULL;
CREATE INDEX IF NOT EXISTS service_estimate_decisions_version_idx
  ON service_estimate_decisions (dealer_id, job_card_id, estimate_version);