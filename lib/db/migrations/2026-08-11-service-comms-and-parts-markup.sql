-- Service communications (FR-COM-03) + dealers schema drift fix.
-- Idempotent; already applied to dev. Run once against each environment.
BEGIN;

-- FR-COM-03: per-dealer cadence for the management scheduled-services
-- summary email ('daily' | 'weekly' | 'off').
ALTER TABLE dealer_service_settings
  ADD COLUMN IF NOT EXISTS summary_cadence text NOT NULL DEFAULT 'daily';

-- Drift fix: dealers.parts_markup_percent existed in the Drizzle schema
-- (parts bulk-import cost-plus pricing) but was never applied to the dev DB,
-- causing every dealer INSERT/SELECT to fail. Default matches the schema.
ALTER TABLE dealers
  ADD COLUMN IF NOT EXISTS parts_markup_percent double precision NOT NULL DEFAULT 25;

COMMIT;
