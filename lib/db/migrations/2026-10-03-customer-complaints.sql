-- Additive tracked development migration. The post-merge hook guards the
-- database host and rejects production bindings before running this file.
BEGIN;
CREATE TABLE IF NOT EXISTS aura_schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS customer_complaints (
  id SERIAL PRIMARY KEY,
  dealer_id INTEGER NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  details TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'open',
  escalated BOOLEAN NOT NULL DEFAULT false,
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_complaints_customer_idx ON customer_complaints (dealer_id, customer_id);
INSERT INTO aura_schema_migrations(name) VALUES ('2026-10-03-customer-complaints')
ON CONFLICT (name) DO NOTHING;
COMMIT;