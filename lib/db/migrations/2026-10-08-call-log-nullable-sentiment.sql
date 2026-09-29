-- Development schema migration; production schema is applied by Publish.
-- Keeping this idempotent allows re-running the dev-side migration safely.
ALTER TABLE call_logs ALTER COLUMN sentiment DROP DEFAULT;
ALTER TABLE call_logs ALTER COLUMN sentiment DROP NOT NULL;