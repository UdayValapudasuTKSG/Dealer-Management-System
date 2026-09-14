-- Explicit provenance for reviewed delivery-history imports. JSON keeps the
-- source worksheet facts additive without inventing a separate arrival domain.
CREATE TABLE IF NOT EXISTS aura_schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS import_metadata jsonb;
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS import_metadata jsonb;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS import_metadata jsonb;

CREATE INDEX IF NOT EXISTS deliveries_import_metadata_batch_idx
  ON deliveries ((import_metadata->>'batchKey'))
  WHERE import_metadata IS NOT NULL;

INSERT INTO aura_schema_migrations(name)
VALUES ('2026-09-23-reviewed-delivery-history-import')
ON CONFLICT (name) DO NOTHING;