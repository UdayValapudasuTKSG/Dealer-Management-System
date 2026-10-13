CREATE TABLE IF NOT EXISTS feedback_automation (
  dealer_id integer NOT NULL,
  kind text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  form_id integer,
  delay_days integer NOT NULL DEFAULT 2,
  channels jsonb NOT NULL DEFAULT '["email"]'::jsonb,
  starts_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dealer_id, kind)
);
ALTER TABLE service_orders ADD COLUMN IF NOT EXISTS closed_at timestamptz;
ALTER TABLE feedback_invitations ADD COLUMN IF NOT EXISTS delivery_id integer;
ALTER TABLE feedback_invitations ADD COLUMN IF NOT EXISTS automation_key text;
ALTER TABLE feedback_invitations ADD COLUMN IF NOT EXISTS automation_kind text;
ALTER TABLE feedback_invitations ADD COLUMN IF NOT EXISTS automation_state text;
ALTER TABLE feedback_invitations ADD COLUMN IF NOT EXISTS automation_error text;
CREATE UNIQUE INDEX IF NOT EXISTS feedback_invitations_automation_key_unique ON feedback_invitations (automation_key);
