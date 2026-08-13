-- Per-dealer theme accent (Task: super-admin managed theme color).
-- Idempotent; already applied to dev. Run once against each environment.
BEGIN;

-- Super-admin-managed theme accent hex (e.g. '#B91C1C') applied to the
-- dealership's AURA workspace in LIGHT mode only; NULL = default bronze.
ALTER TABLE dealers
  ADD COLUMN IF NOT EXISTS theme_color text;

COMMIT;
