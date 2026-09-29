-- Additive development migration; production schema changes are managed by Publish.
BEGIN;
ALTER TABLE customer_complaints ALTER COLUMN customer_id DROP NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customer_complaints_link_check'
    AND conrelid = 'customer_complaints'::regclass) THEN
    ALTER TABLE customer_complaints ADD CONSTRAINT customer_complaints_link_check
      CHECK (customer_id IS NOT NULL OR lead_id IS NOT NULL);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS customer_complaints_lead_idx ON customer_complaints (dealer_id, lead_id);
COMMIT;