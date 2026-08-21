-- Per-dealer SMTP connections + per-dealer email template overrides.
-- Idempotent: safe to run on databases where drizzle push already created
-- the tables (dev) and on deployments that have neither (prod).

CREATE TABLE IF NOT EXISTS smtp_connections (
  id serial PRIMARY KEY,
  dealer_id integer NOT NULL,
  host text NOT NULL,
  port integer NOT NULL,
  security text NOT NULL DEFAULT 'ssl',
  username text NOT NULL,
  password_ciphertext text,
  from_email text NOT NULL,
  from_name text,
  reply_to text,
  enabled boolean NOT NULL DEFAULT true,
  last_status text,
  last_error text,
  last_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS smtp_connections_dealer_uq
  ON smtp_connections (dealer_id);
CREATE INDEX IF NOT EXISTS smtp_connections_dealer_idx
  ON smtp_connections (dealer_id);

CREATE TABLE IF NOT EXISTS email_template_overrides (
  id serial PRIMARY KEY,
  dealer_id integer NOT NULL,
  template_key text NOT NULL,
  subject text,
  heading text,
  body text,
  cta_label text,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS email_template_overrides_dealer_key_uq
  ON email_template_overrides (dealer_id, template_key);
CREATE INDEX IF NOT EXISTS email_template_overrides_dealer_idx
  ON email_template_overrides (dealer_id);
