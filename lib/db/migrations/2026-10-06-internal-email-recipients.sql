BEGIN;
CREATE TABLE IF NOT EXISTS aura_schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS internal_email_recipients (
  id serial PRIMARY KEY,
  dealer_id integer NOT NULL,
  template_key text NOT NULL,
  user_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT internal_email_recipients_dealer_key_uq UNIQUE (dealer_id, template_key)
);
INSERT INTO aura_schema_migrations(name)
VALUES ('2026-10-06-internal-email-recipients')
ON CONFLICT (name) DO NOTHING;
COMMIT;