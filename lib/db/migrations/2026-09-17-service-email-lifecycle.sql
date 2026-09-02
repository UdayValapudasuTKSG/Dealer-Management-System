-- Secure, tenant/entity-bound, whole-estimate customer decisions.
-- Idempotent: safe for tracked migration runners to retry.
CREATE TABLE IF NOT EXISTS service_estimate_decisions (
  id serial PRIMARY KEY,
  dealer_id integer NOT NULL,
  service_order_id integer NOT NULL,
  job_card_id integer NOT NULL,
  token_hash text NOT NULL,
  estimate_total double precision NOT NULL,
  lines_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  expires_at timestamptz NOT NULL,
  decision text,
  decided_at timestamptz,
  invalidated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_estimate_decisions_decision_ck
    CHECK (decision IS NULL OR decision IN ('approved', 'declined'))
);

CREATE UNIQUE INDEX IF NOT EXISTS service_estimate_decisions_token_hash_uq
  ON service_estimate_decisions (token_hash);
CREATE INDEX IF NOT EXISTS service_estimate_decisions_entity_idx
  ON service_estimate_decisions (dealer_id, service_order_id, job_card_id);
DO $$ BEGIN
  ALTER TABLE service_estimate_decisions ADD CONSTRAINT service_estimate_decisions_order_fk
    FOREIGN KEY (service_order_id) REFERENCES service_orders(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE service_estimate_decisions ADD CONSTRAINT service_estimate_decisions_job_card_fk
    FOREIGN KEY (job_card_id) REFERENCES job_cards(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Generalize invitations for the service CSAT lifecycle while retaining
-- existing lead invitations and their legacy plaintext tokens.
ALTER TABLE feedback_invitations ALTER COLUMN lead_id DROP NOT NULL;
ALTER TABLE feedback_invitations ALTER COLUMN token DROP NOT NULL;
ALTER TABLE feedback_invitations ADD COLUMN IF NOT EXISTS service_order_id integer;
ALTER TABLE feedback_invitations ADD COLUMN IF NOT EXISTS customer_id integer;
ALTER TABLE feedback_invitations ADD COLUMN IF NOT EXISTS vehicle_label text;
ALTER TABLE feedback_invitations ADD COLUMN IF NOT EXISTS token_hash text;
CREATE UNIQUE INDEX IF NOT EXISTS feedback_invitations_token_hash_uq
  ON feedback_invitations (token_hash) WHERE token_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS feedback_invitations_service_order_uq
  ON feedback_invitations (dealer_id, service_order_id)
  WHERE service_order_id IS NOT NULL;
DO $$ BEGIN
  ALTER TABLE feedback_invitations ADD CONSTRAINT feedback_invitations_service_order_fk
    FOREIGN KEY (service_order_id) REFERENCES service_orders(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE feedback_invitations ADD CONSTRAINT feedback_invitations_customer_fk
    FOREIGN KEY (customer_id) REFERENCES customers(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;