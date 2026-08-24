-- Per-dealer Meta Lead Ads credentials (page token / app secret encrypted,
-- verify token GM-readable). Idempotent; safe to re-run.
CREATE TABLE IF NOT EXISTS meta_connections (
  id SERIAL PRIMARY KEY,
  dealer_id INTEGER NOT NULL,
  page_access_token_ciphertext TEXT,
  app_secret_ciphertext TEXT,
  verify_token TEXT,
  last_status TEXT,
  last_error TEXT,
  last_checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS meta_connections_dealer_uq
  ON meta_connections (dealer_id);
