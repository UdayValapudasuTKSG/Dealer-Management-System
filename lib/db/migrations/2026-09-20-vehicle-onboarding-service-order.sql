-- Bind new customer vehicle onboarding invites to one originating service order.
-- Existing invites intentionally remain NULL and retain garage-only behavior.
CREATE TABLE IF NOT EXISTS aura_schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE vehicle_onboarding_requests
  ADD COLUMN IF NOT EXISTS service_order_id integer;

DO $$ BEGIN
  ALTER TABLE vehicle_onboarding_requests
    ADD CONSTRAINT vehicle_onboarding_requests_service_order_fk
    FOREIGN KEY (service_order_id) REFERENCES service_orders(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS vehicle_onboarding_requests_service_order_idx
  ON vehicle_onboarding_requests(service_order_id);

INSERT INTO aura_schema_migrations(name)
VALUES ('2026-09-20-vehicle-onboarding-service-order')
ON CONFLICT (name) DO NOTHING;