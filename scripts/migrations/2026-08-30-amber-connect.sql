-- Amber Connect telematics module (task: Amber Connect).
-- Idempotent, additive-only. Safe to re-run.

CREATE TABLE IF NOT EXISTS amber_connections (
  id serial PRIMARY KEY,
  dealer_id integer NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  api_base_url text,
  api_key_ciphertext text,
  api_key_hint text,
  webhook_secret text NOT NULL,
  last_status text,
  last_error text,
  last_checked_at timestamptz,
  last_sync_status text,
  last_sync_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS amber_connections_dealer_uq ON amber_connections (dealer_id);

CREATE TABLE IF NOT EXISTS amber_devices (
  id serial PRIMARY KEY,
  dealer_id integer NOT NULL,
  device_id text NOT NULL,
  reported_vin text,
  label text,
  vehicle_id integer,
  mapping_status text NOT NULL DEFAULT 'unmatched',
  conflict_reason text,
  mapped_by text,
  mapped_at timestamptz,
  last_seen_at timestamptz,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS amber_devices_dealer_device_uq ON amber_devices (dealer_id, device_id);
CREATE INDEX IF NOT EXISTS amber_devices_vehicle_idx ON amber_devices (vehicle_id);

CREATE TABLE IF NOT EXISTS amber_events (
  id serial PRIMARY KEY,
  dealer_id integer NOT NULL,
  device_id text NOT NULL,
  external_id text NOT NULL,
  type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  payload jsonb,
  status text NOT NULL DEFAULT 'processed',
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS amber_events_dealer_external_uq ON amber_events (dealer_id, external_id);
CREATE INDEX IF NOT EXISTS amber_events_dealer_device_idx ON amber_events (dealer_id, device_id);
CREATE INDEX IF NOT EXISTS amber_events_created_idx ON amber_events (created_at);

CREATE TABLE IF NOT EXISTS amber_vehicle_states (
  id serial PRIMARY KEY,
  dealer_id integer NOT NULL,
  device_id text NOT NULL,
  vehicle_id integer,
  latitude double precision,
  longitude double precision,
  location_at timestamptz,
  odometer_km double precision,
  odometer_at timestamptz,
  ignition_on boolean,
  ignition_at timestamptz,
  device_health text,
  device_health_at timestamptz,
  last_event_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS amber_states_dealer_device_uq ON amber_vehicle_states (dealer_id, device_id);
CREATE INDEX IF NOT EXISTS amber_states_vehicle_idx ON amber_vehicle_states (vehicle_id);

-- RBAC: idempotent backfill of the new "amber" permission module onto the
-- existing seeded system roles (GM full; Sales/Service Manager view).
INSERT INTO role_permissions (role_id, module, category)
SELECT r.id, 'amber', c.category
FROM roles r
CROSS JOIN (VALUES ('view'), ('create'), ('edit'), ('delete'), ('approve'),
                   ('reject'), ('export'), ('assign'), ('admin')) AS c(category)
WHERE r.name = 'General Manager' AND r.is_system = true
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, module, category)
SELECT r.id, 'amber', 'view'
FROM roles r
WHERE r.name IN ('Sales Manager', 'Service Manager') AND r.is_system = true
ON CONFLICT DO NOTHING;

-- One active device per vehicle (concurrency-safe mapping conflict enforcement)
CREATE UNIQUE INDEX IF NOT EXISTS amber_devices_dealer_vehicle_uq
  ON amber_devices (dealer_id, vehicle_id) WHERE vehicle_id IS NOT NULL;
