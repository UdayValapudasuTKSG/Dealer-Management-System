-- Quote duty-free authority and reasoned destructive-action gates.
-- Safe for existing dealers and repeat migration execution.
ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS request_type text NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS duty_free_status text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS duty_free_reason text,
  ADD COLUMN IF NOT EXISTS duty_free_requested_by text,
  ADD COLUMN IF NOT EXISTS duty_free_gate_id integer,
  ADD COLUMN IF NOT EXISTS tax_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS duty_free_approved boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS tax_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS cancellation_gate_id integer;

WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY dealer_id, type, ref_id ORDER BY created_at, id
  ) AS rn
  FROM gates
  WHERE status = 'pending'
    AND type IN ('quote_duty_free', 'deal_cancellation', 'lead_delete')
    AND ref_id IS NOT NULL
)
UPDATE gates SET status = 'dismissed'
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

DROP INDEX IF EXISTS gates_pending_quote_duty_free_idx;
CREATE UNIQUE INDEX gates_pending_quote_duty_free_idx
  ON gates (dealer_id, ref_id)
  WHERE type = 'quote_duty_free' AND status = 'pending';
DROP INDEX IF EXISTS gates_pending_deal_cancellation_idx;
CREATE UNIQUE INDEX gates_pending_deal_cancellation_idx
  ON gates (dealer_id, ref_id)
  WHERE type = 'deal_cancellation' AND status = 'pending';
DROP INDEX IF EXISTS gates_pending_lead_delete_idx;
CREATE UNIQUE INDEX gates_pending_lead_delete_idx
  ON gates (dealer_id, ref_id)
  WHERE type = 'lead_delete' AND status = 'pending';