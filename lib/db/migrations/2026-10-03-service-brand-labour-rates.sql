-- Additive, idempotent workshop brand-pricing metadata. Existing bookings,
-- job-card GYD snapshots, estimates and invoices are intentionally untouched.
ALTER TABLE dealer_service_settings
  ADD COLUMN IF NOT EXISTS brand_labour_rates jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE service_orders
  ADD COLUMN IF NOT EXISTS brand text;