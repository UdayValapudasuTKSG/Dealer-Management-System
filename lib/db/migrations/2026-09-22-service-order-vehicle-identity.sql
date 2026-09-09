-- Persist the vehicle identifiers captured during service booking.
-- Columns remain nullable for historical service orders; the API requires both
-- values for all new bookings.
CREATE TABLE IF NOT EXISTS aura_schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE service_orders
  ADD COLUMN IF NOT EXISTS vin text,
  ADD COLUMN IF NOT EXISTS registration_number text;

CREATE INDEX IF NOT EXISTS service_orders_dealer_vin_idx
  ON service_orders(dealer_id, vin);

CREATE INDEX IF NOT EXISTS service_orders_dealer_registration_idx
  ON service_orders(dealer_id, registration_number);

INSERT INTO aura_schema_migrations(name)
VALUES ('2026-09-22-service-order-vehicle-identity')
ON CONFLICT (name) DO NOTHING;