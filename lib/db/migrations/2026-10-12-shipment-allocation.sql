-- Additive DEVELOPMENT migration: shipment allocation (BRD v1.1).
-- New tables only; no backfill, no changes to existing rows. Publish owns
-- managed production schema changes.
CREATE TABLE IF NOT EXISTS shipment_specs (
  id serial PRIMARY KEY,
  dealer_id integer NOT NULL,
  make text NOT NULL,
  model text NOT NULL,
  year integer NOT NULL,
  variant text NOT NULL,
  exterior_color text NOT NULL,
  interior_color text NOT NULL,
  spec_key text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  approved_by text,
  approved_at timestamptz,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shipment_specs_status_ck CHECK (status in ('draft','approved','retired')),
  CONSTRAINT shipment_specs_nonblank_ck CHECK (btrim(make) <> '' and btrim(model) <> '' and btrim(variant) <> '' and btrim(exterior_color) <> '' and btrim(interior_color) <> '')
);
CREATE UNIQUE INDEX IF NOT EXISTS shipment_specs_dealer_key_uq ON shipment_specs (dealer_id, spec_key);
CREATE INDEX IF NOT EXISTS shipment_specs_dealer_status_idx ON shipment_specs (dealer_id, status);

CREATE TABLE IF NOT EXISTS shipments (
  id serial PRIMARY KEY,
  dealer_id integer NOT NULL,
  reference text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  baseline_eta_month text NOT NULL,
  current_eta_month text NOT NULL,
  notes text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shipments_status_ck CHECK (status in ('open','in_transit','arrived','closed','cancelled')),
  CONSTRAINT shipments_eta_ck CHECK (baseline_eta_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' and current_eta_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);
CREATE UNIQUE INDEX IF NOT EXISTS shipments_dealer_reference_uq ON shipments (dealer_id, lower(reference));
CREATE INDEX IF NOT EXISTS shipments_dealer_status_idx ON shipments (dealer_id, status);

CREATE TABLE IF NOT EXISTS shipment_lines (
  id serial PRIMARY KEY,
  dealer_id integer NOT NULL,
  shipment_id integer NOT NULL REFERENCES shipments(id) ON DELETE restrict,
  spec_id integer NOT NULL REFERENCES shipment_specs(id) ON DELETE restrict,
  quantity integer NOT NULL,
  import_batch_id integer,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shipment_lines_qty_ck CHECK (quantity > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS shipment_lines_shipment_spec_uq ON shipment_lines (shipment_id, spec_id);
CREATE INDEX IF NOT EXISTS shipment_lines_dealer_spec_idx ON shipment_lines (dealer_id, spec_id);

CREATE TABLE IF NOT EXISTS shipment_edit_locks (
  id serial PRIMARY KEY,
  dealer_id integer NOT NULL,
  shipment_id integer NOT NULL REFERENCES shipments(id) ON DELETE cascade,
  holder_user_id integer NOT NULL,
  holder_name text NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS shipment_edit_locks_shipment_uq ON shipment_edit_locks (shipment_id);

CREATE TABLE IF NOT EXISTS shipment_allocations (
  id serial PRIMARY KEY,
  dealer_id integer NOT NULL,
  shipment_id integer NOT NULL REFERENCES shipments(id) ON DELETE restrict,
  shipment_line_id integer NOT NULL REFERENCES shipment_lines(id) ON DELETE restrict,
  spec_id integer NOT NULL REFERENCES shipment_specs(id) ON DELETE restrict,
  lead_id integer NOT NULL,
  deal_id integer,
  requested_quantity integer NOT NULL,
  quantity integer NOT NULL,
  partial_consent boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active',
  baseline_at timestamptz NOT NULL,
  baseline_eta_month text NOT NULL,
  specs_confirmed_by text NOT NULL,
  reassigned_from_id integer,
  released_reason text,
  released_at timestamptz,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shipment_allocations_status_ck CHECK (status in ('active','fulfilled','released','reassigned')),
  CONSTRAINT shipment_allocations_qty_ck CHECK (quantity > 0 and quantity <= requested_quantity and (quantity = requested_quantity or partial_consent))
);
CREATE UNIQUE INDEX IF NOT EXISTS shipment_allocations_lead_spec_active_uq ON shipment_allocations (dealer_id, lead_id, spec_id) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS shipment_allocations_reassigned_from_uq ON shipment_allocations (reassigned_from_id) WHERE reassigned_from_id is not null;
CREATE INDEX IF NOT EXISTS shipment_allocations_line_idx ON shipment_allocations (shipment_line_id, status);
CREATE INDEX IF NOT EXISTS shipment_allocations_dealer_lead_idx ON shipment_allocations (dealer_id, lead_id);

CREATE TABLE IF NOT EXISTS shipment_events (
  id serial PRIMARY KEY,
  dealer_id integer NOT NULL,
  shipment_id integer,
  allocation_id integer,
  kind text NOT NULL,
  detail text NOT NULL,
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shipment_events_dealer_shipment_idx ON shipment_events (dealer_id, shipment_id, created_at);

CREATE TABLE IF NOT EXISTS shipment_email_jobs (
  id serial PRIMARY KEY,
  dealer_id integer NOT NULL,
  shipment_id integer NOT NULL,
  allocation_id integer NOT NULL,
  kind text NOT NULL,
  eta_month text NOT NULL,
  status text NOT NULL,
  reason text NOT NULL,
  superseded_by_id integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shipment_email_jobs_kind_ck CHECK (kind in ('initial','eta_change')),
  CONSTRAINT shipment_email_jobs_status_ck CHECK (status in ('queued','withheld','suppressed','superseded','sent','failed'))
);
CREATE INDEX IF NOT EXISTS shipment_email_jobs_alloc_idx ON shipment_email_jobs (dealer_id, allocation_id);

CREATE TABLE IF NOT EXISTS shipment_import_batches (
  id serial PRIMARY KEY,
  dealer_id integer NOT NULL,
  shipment_id integer NOT NULL REFERENCES shipments(id) ON DELETE restrict,
  kind text NOT NULL,
  file_name text NOT NULL,
  file_hash text NOT NULL,
  total_rows integer NOT NULL,
  accepted_rows integer NOT NULL,
  rejected_rows integer NOT NULL,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shipment_import_batches_kind_ck CHECK (kind in ('lines','manifest'))
);
CREATE UNIQUE INDEX IF NOT EXISTS shipment_import_batches_hash_uq ON shipment_import_batches (dealer_id, shipment_id, kind, file_hash);

CREATE TABLE IF NOT EXISTS shipment_import_row_errors (
  id serial PRIMARY KEY,
  dealer_id integer NOT NULL,
  batch_id integer NOT NULL REFERENCES shipment_import_batches(id) ON DELETE cascade,
  row_number integer NOT NULL,
  message text NOT NULL,
  raw_row text NOT NULL
);
CREATE INDEX IF NOT EXISTS shipment_import_row_errors_batch_idx ON shipment_import_row_errors (batch_id, row_number);

CREATE TABLE IF NOT EXISTS shipment_manifests (
  id serial PRIMARY KEY,
  dealer_id integer NOT NULL,
  shipment_id integer NOT NULL REFERENCES shipments(id) ON DELETE restrict,
  spec_id integer NOT NULL REFERENCES shipment_specs(id) ON DELETE restrict,
  vin text NOT NULL,
  status text NOT NULL DEFAULT 'unmatched',
  import_batch_id integer,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shipment_manifests_vin_ck CHECK (vin ~ '^[A-HJ-NPR-Z0-9]{17}$'),
  CONSTRAINT shipment_manifests_status_ck CHECK (status in ('unmatched','proposed','confirmed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS shipment_manifests_dealer_vin_uq ON shipment_manifests (dealer_id, vin);
CREATE INDEX IF NOT EXISTS shipment_manifests_shipment_idx ON shipment_manifests (shipment_id, spec_id);

CREATE TABLE IF NOT EXISTS shipment_match_runs (
  id serial PRIMARY KEY,
  dealer_id integer NOT NULL,
  shipment_id integer NOT NULL REFERENCES shipments(id) ON DELETE restrict,
  proposed_count integer NOT NULL,
  shortage_units integer NOT NULL,
  unmatched_vins integer NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shipment_match_runs_shipment_idx ON shipment_match_runs (dealer_id, shipment_id);

CREATE TABLE IF NOT EXISTS shipment_match_proposals (
  id serial PRIMARY KEY,
  dealer_id integer NOT NULL,
  shipment_id integer NOT NULL,
  run_id integer NOT NULL REFERENCES shipment_match_runs(id) ON DELETE restrict,
  manifest_id integer NOT NULL REFERENCES shipment_manifests(id) ON DELETE restrict,
  allocation_id integer NOT NULL REFERENCES shipment_allocations(id) ON DELETE restrict,
  status text NOT NULL DEFAULT 'pending',
  last_blocked_reason text,
  interior_verified boolean NOT NULL DEFAULT false,
  reservation_allocation_id integer,
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shipment_match_proposals_status_ck CHECK (status in ('pending','confirmed','superseded','rejected'))
);
CREATE UNIQUE INDEX IF NOT EXISTS shipment_match_proposals_manifest_live_uq ON shipment_match_proposals (manifest_id) WHERE status in ('pending','confirmed');
CREATE INDEX IF NOT EXISTS shipment_match_proposals_alloc_idx ON shipment_match_proposals (allocation_id, status);
