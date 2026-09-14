-- Historical delivery imports can create a sales lead without treating it as
-- a new enquiry. Keep that provenance on the lead itself; customer consent is
-- intentionally not changed.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS import_metadata jsonb;

CREATE INDEX IF NOT EXISTS leads_import_metadata_batch_idx
  ON leads ((import_metadata->>'batchKey'))
  WHERE import_metadata IS NOT NULL;

INSERT INTO aura_schema_migrations(name)
VALUES ('2026-09-24-reviewed-delivery-history-leads')
ON CONFLICT (name) DO NOTHING;