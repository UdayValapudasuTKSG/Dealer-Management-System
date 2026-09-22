-- Additive only: existing catalogue prices and stock are unchanged.
ALTER TABLE parts ADD COLUMN IF NOT EXISTS pricing_details jsonb;