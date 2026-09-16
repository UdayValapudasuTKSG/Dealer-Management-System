-- Customer authorization and staff receipt acknowledgement are separate,
-- version-bound attestations. This is additive only: no production row is
-- inferred or backfilled as acknowledged.
ALTER TABLE job_cards
  ADD COLUMN IF NOT EXISTS estimate_staff_acknowledged_version integer,
  ADD COLUMN IF NOT EXISTS estimate_staff_acknowledged_decision_id integer,
  ADD COLUMN IF NOT EXISTS estimate_staff_acknowledged_by_user_id integer,
  ADD COLUMN IF NOT EXISTS estimate_staff_acknowledged_by_name text,
  ADD COLUMN IF NOT EXISTS estimate_staff_acknowledged_at timestamptz;

ALTER TABLE job_cards
  DROP CONSTRAINT IF EXISTS job_cards_estimate_staff_ack_version_check;
ALTER TABLE job_cards
  ADD CONSTRAINT job_cards_estimate_staff_ack_version_check CHECK (
    (estimate_staff_acknowledged_version IS NULL
      AND estimate_staff_acknowledged_decision_id IS NULL
      AND estimate_staff_acknowledged_by_user_id IS NULL
      AND estimate_staff_acknowledged_by_name IS NULL
      AND estimate_staff_acknowledged_at IS NULL)
    OR
    (estimate_staff_acknowledged_version IS NOT NULL
      AND estimate_staff_acknowledged_decision_id IS NOT NULL
      AND estimate_staff_acknowledged_by_user_id IS NOT NULL
      AND estimate_staff_acknowledged_by_name IS NOT NULL
      AND estimate_staff_acknowledged_at IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS job_cards_estimate_staff_ack_idx
  ON job_cards (
    dealer_id,
    estimate_staff_acknowledged_version,
    estimate_staff_acknowledged_decision_id
  )
  WHERE estimate_staff_acknowledged_version IS NOT NULL;

ALTER TABLE email_logs
  ADD COLUMN IF NOT EXISTS service_estimate_decision_id integer
  REFERENCES service_estimate_decisions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS email_logs_service_estimate_decision_idx
  ON email_logs (dealer_id, service_estimate_decision_id)
  WHERE service_estimate_decision_id IS NOT NULL;