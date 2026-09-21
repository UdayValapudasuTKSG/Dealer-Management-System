-- DEVELOPMENT ONLY. Additive, idempotent foundation; no startup execution.
BEGIN;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS address text, ADD COLUMN IF NOT EXISTS lead_time_days integer NOT NULL DEFAULT 7;
ALTER TABLE parts ADD COLUMN IF NOT EXISTS description text, ADD COLUMN IF NOT EXISTS barcode text,
 ADD COLUMN IF NOT EXISTS costing_method text NOT NULL DEFAULT 'average',
 ADD COLUMN IF NOT EXISTS reorder_max integer NOT NULL DEFAULT 10,
 ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true,
 ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
 ADD COLUMN IF NOT EXISTS inventory_initialized_at timestamptz;
ALTER TABLE purchase_orders ALTER COLUMN supplier_id DROP NOT NULL;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual',
 ADD COLUMN IF NOT EXISTS location_id integer, ADD COLUMN IF NOT EXISTS job_card_id integer,
 ADD COLUMN IF NOT EXISTS estimate_id integer, ADD COLUMN IF NOT EXISTS advisor_id integer,
 ADD COLUMN IF NOT EXISTS created_by integer, ADD COLUMN IF NOT EXISTS sent_at timestamptz,
 ADD COLUMN IF NOT EXISTS send_count integer NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS needs_supplier boolean NOT NULL DEFAULT false;
ALTER TABLE purchase_order_lines ADD COLUMN IF NOT EXISTS landed_cost_components jsonb NOT NULL DEFAULT '{}', ADD COLUMN IF NOT EXISTS landed_unit_cost double precision;
ALTER TABLE job_card_parts ADD COLUMN IF NOT EXISTS inventory_hold_id integer,
 ADD COLUMN IF NOT EXISTS inventory_location_id integer, ADD COLUMN IF NOT EXISTS inventory_bin_id integer,
 ADD COLUMN IF NOT EXISTS issued_quantity integer, ADD COLUMN IF NOT EXISTS issued_at timestamptz;
ALTER TABLE part_credit_notes ADD COLUMN IF NOT EXISTS condition text NOT NULL DEFAULT 'resalable', ADD COLUMN IF NOT EXISTS inventory_transaction_id integer;
CREATE TABLE IF NOT EXISTS inventory_locations (
 id serial PRIMARY KEY, dealer_id integer NOT NULL, name text NOT NULL, type text NOT NULL DEFAULT 'warehouse',
 address text, active boolean NOT NULL DEFAULT true, is_default boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), CONSTRAINT inventory_locations_type_ck CHECK(type IN ('branch','warehouse')));
CREATE UNIQUE INDEX IF NOT EXISTS inventory_locations_dealer_name_uq ON inventory_locations(dealer_id,name);
CREATE UNIQUE INDEX IF NOT EXISTS inventory_locations_default_uq ON inventory_locations(dealer_id) WHERE is_default;
CREATE TABLE IF NOT EXISTS inventory_bins (
 id serial PRIMARY KEY, dealer_id integer NOT NULL, location_id integer NOT NULL REFERENCES inventory_locations(id),
 code text NOT NULL, description text, active boolean NOT NULL DEFAULT true);
CREATE UNIQUE INDEX IF NOT EXISTS inventory_bins_scope_uq ON inventory_bins(dealer_id,location_id,code);
CREATE TABLE IF NOT EXISTS inventory_levels (
 id serial PRIMARY KEY, dealer_id integer NOT NULL, part_id integer NOT NULL REFERENCES parts(id),
 location_id integer NOT NULL REFERENCES inventory_locations(id), bin_id integer REFERENCES inventory_bins(id),
 quantity_on_hand integer NOT NULL DEFAULT 0, quantity_reserved integer NOT NULL DEFAULT 0,
 quantity_non_sellable integer NOT NULL DEFAULT 0, average_unit_cost double precision NOT NULL DEFAULT 0,
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT inventory_levels_quantities_ck CHECK(quantity_on_hand >= 0 AND quantity_reserved >= 0 AND quantity_non_sellable >= 0 AND quantity_non_sellable <= quantity_on_hand AND average_unit_cost >= 0));
CREATE UNIQUE INDEX IF NOT EXISTS inventory_levels_scope_uq ON inventory_levels(dealer_id,part_id,location_id,coalesce(bin_id,0));
CREATE INDEX IF NOT EXISTS inventory_levels_location_idx ON inventory_levels(dealer_id,location_id);
CREATE TABLE IF NOT EXISTS inventory_transactions (
 id serial PRIMARY KEY, dealer_id integer NOT NULL, part_id integer NOT NULL REFERENCES parts(id),
 location_id integer NOT NULL REFERENCES inventory_locations(id), bin_id integer REFERENCES inventory_bins(id),
 type text NOT NULL, quantity_delta integer NOT NULL, non_sellable_delta integer NOT NULL DEFAULT 0,
 reference_type text NOT NULL, reference_id text NOT NULL, unit_cost_at_transaction double precision NOT NULL,
 value_delta double precision NOT NULL, created_by integer, created_at timestamptz NOT NULL DEFAULT now(),
 idempotency_key text, notes text,
 CONSTRAINT inventory_transactions_type_ck CHECK(type IN ('receipt','issue','transfer','adjustment','cycle_count','return','opening')),
 CONSTRAINT inventory_transactions_cost_ck CHECK(unit_cost_at_transaction >= 0));
CREATE INDEX IF NOT EXISTS inventory_transactions_history_idx ON inventory_transactions(dealer_id,part_id,location_id,created_at);
CREATE INDEX IF NOT EXISTS inventory_transactions_reference_idx ON inventory_transactions(dealer_id,reference_type,reference_id);
CREATE UNIQUE INDEX IF NOT EXISTS inventory_transactions_idempotency_uq ON inventory_transactions(dealer_id,idempotency_key);
CREATE TABLE IF NOT EXISTS inventory_cost_layers (
 id serial PRIMARY KEY, dealer_id integer NOT NULL, part_id integer NOT NULL REFERENCES parts(id),
 location_id integer NOT NULL REFERENCES inventory_locations(id), bin_id integer REFERENCES inventory_bins(id),
 receipt_transaction_id integer NOT NULL REFERENCES inventory_transactions(id),
 quantity_received integer NOT NULL, quantity_remaining integer NOT NULL, unit_cost double precision NOT NULL,
 non_sellable boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT inventory_cost_layers_quantities_ck CHECK(quantity_received > 0 AND quantity_remaining >= 0 AND quantity_remaining <= quantity_received AND unit_cost >= 0));
CREATE INDEX IF NOT EXISTS inventory_cost_layers_fifo_idx ON inventory_cost_layers(dealer_id,part_id,location_id,created_at);
CREATE TABLE IF NOT EXISTS inventory_cost_consumptions (
 id serial PRIMARY KEY, dealer_id integer NOT NULL, layer_id integer NOT NULL REFERENCES inventory_cost_layers(id),
 transaction_id integer NOT NULL REFERENCES inventory_transactions(id), quantity integer NOT NULL,
 unit_cost double precision NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT inventory_cost_consumptions_values_ck CHECK(quantity > 0 AND unit_cost >= 0));
CREATE INDEX IF NOT EXISTS inventory_cost_consumptions_history_idx ON inventory_cost_consumptions(dealer_id,layer_id,created_at);
CREATE UNIQUE INDEX IF NOT EXISTS inventory_cost_consumptions_tx_layer_uq ON inventory_cost_consumptions(dealer_id,transaction_id,layer_id);
CREATE TABLE IF NOT EXISTS inventory_holds (
 id serial PRIMARY KEY, dealer_id integer NOT NULL, part_id integer NOT NULL REFERENCES parts(id),
 location_id integer NOT NULL REFERENCES inventory_locations(id), bin_id integer REFERENCES inventory_bins(id),
 quantity integer NOT NULL, reference_type text NOT NULL, reference_id text NOT NULL,
 status text NOT NULL DEFAULT 'active', backorder_risk boolean NOT NULL DEFAULT false,
 expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days', released_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), created_by integer,
 CONSTRAINT inventory_holds_values_ck CHECK(quantity > 0 AND status IN ('active','released','consumed')));
CREATE INDEX IF NOT EXISTS inventory_holds_reference_idx ON inventory_holds(dealer_id,reference_type,reference_id);
CREATE INDEX IF NOT EXISTS inventory_holds_expiry_idx ON inventory_holds(dealer_id,status,expires_at);
CREATE TABLE IF NOT EXISTS inventory_cycle_counts (
 id serial PRIMARY KEY, dealer_id integer NOT NULL, location_id integer NOT NULL REFERENCES inventory_locations(id),
 bin_id integer REFERENCES inventory_bins(id), category text, status text NOT NULL DEFAULT 'in_progress',
 started_by integer, started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, approved_by integer,
 CONSTRAINT inventory_cycle_counts_status_ck CHECK(status IN ('in_progress','pending_approval','completed','cancelled')));
CREATE INDEX IF NOT EXISTS inventory_cycle_counts_scope_idx ON inventory_cycle_counts(dealer_id,location_id,status);
CREATE TABLE IF NOT EXISTS inventory_cycle_count_lines (
 id serial PRIMARY KEY, dealer_id integer NOT NULL, cycle_count_id integer NOT NULL REFERENCES inventory_cycle_counts(id),
 part_id integer NOT NULL REFERENCES parts(id), bin_id integer REFERENCES inventory_bins(id),
 expected_qty integer NOT NULL, counted_qty integer, variance integer, approved_by integer,
 transaction_id integer REFERENCES inventory_transactions(id),
 CONSTRAINT inventory_cycle_count_lines_qty_ck CHECK(expected_qty >= 0 AND (counted_qty IS NULL OR counted_qty >= 0)));
CREATE UNIQUE INDEX IF NOT EXISTS inventory_cycle_count_lines_scope_uq ON inventory_cycle_count_lines(dealer_id,cycle_count_id,part_id,coalesce(bin_id,0));
CREATE TABLE IF NOT EXISTS part_pricing_policies (
 id serial PRIMARY KEY, dealer_id integer NOT NULL, category text, markup_factor double precision NOT NULL DEFAULT 1,
 reconciliation_tolerance_percent double precision NOT NULL DEFAULT 2, hold_expiry_days integer NOT NULL DEFAULT 7,
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT part_pricing_policies_values_ck CHECK(markup_factor >= 0 AND reconciliation_tolerance_percent >= 0 AND hold_expiry_days > 0));
CREATE UNIQUE INDEX IF NOT EXISTS part_pricing_policies_category_uq ON part_pricing_policies(dealer_id,coalesce(category,''));
CREATE TABLE IF NOT EXISTS part_import_jobs (
 id serial PRIMARY KEY, dealer_id integer NOT NULL, status text NOT NULL DEFAULT 'pending', mode text NOT NULL DEFAULT 'reject',
 file_name text NOT NULL, column_mapping jsonb NOT NULL DEFAULT '{}', rows jsonb NOT NULL DEFAULT '[]', errors jsonb NOT NULL DEFAULT '[]',
 processed_rows integer NOT NULL DEFAULT 0, total_rows integer NOT NULL DEFAULT 0, created_by integer,
 created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, completed_at timestamptz, error_message text,
 CONSTRAINT part_import_jobs_status_ck CHECK(status IN ('pending','validating','validated','invalid','queued','processing','completed','failed') AND mode IN ('reject','upsert')),
 CONSTRAINT part_import_jobs_progress_ck CHECK(processed_rows >= 0 AND total_rows >= 0 AND processed_rows <= total_rows));
CREATE INDEX IF NOT EXISTS part_import_jobs_queue_idx ON part_import_jobs(dealer_id,status,created_at);
CREATE TABLE IF NOT EXISTS part_reconciliations (
 id serial PRIMARY KEY, dealer_id integer NOT NULL, purchase_order_id integer NOT NULL REFERENCES purchase_orders(id),
 purchase_order_line_id integer NOT NULL REFERENCES purchase_order_lines(id), receipt_id integer REFERENCES purchase_order_receipts(id),
 invoice_number text, invoice_quantity integer, invoice_unit_cost double precision, received_quantity integer NOT NULL,
 tolerance_percent double precision NOT NULL DEFAULT 2, status text NOT NULL DEFAULT 'pending', resolution text, notes text,
 resolved_by integer, resolved_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT part_reconciliations_values_ck CHECK(received_quantity >= 0 AND tolerance_percent >= 0 AND (invoice_quantity IS NULL OR invoice_quantity >= 0) AND (invoice_unit_cost IS NULL OR invoice_unit_cost >= 0)),
 CONSTRAINT part_reconciliations_status_ck CHECK(status IN ('pending','matched','flagged','resolved')));
CREATE INDEX IF NOT EXISTS part_reconciliations_queue_idx ON part_reconciliations(dealer_id,status,purchase_order_id);
CREATE TABLE IF NOT EXISTS part_notification_deliveries (
 id serial PRIMARY KEY, dealer_id integer NOT NULL, recipient_id integer NOT NULL, channel text NOT NULL,
 type text NOT NULL, reference_type text NOT NULL, reference_id text NOT NULL, status text NOT NULL DEFAULT 'pending',
 attempts integer NOT NULL DEFAULT 0, payload jsonb NOT NULL DEFAULT '{}', error_message text, sent_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT part_notification_deliveries_values_ck CHECK(attempts >= 0 AND channel IN ('internal','sms','email') AND status IN ('pending','sending','sent','failed')));
CREATE UNIQUE INDEX IF NOT EXISTS part_notification_deliveries_dedupe_uq ON part_notification_deliveries(dealer_id,recipient_id,channel,type,reference_type,reference_id);
CREATE INDEX IF NOT EXISTS part_notification_deliveries_queue_idx ON part_notification_deliveries(dealer_id,status);
CREATE INDEX IF NOT EXISTS suppliers_dealer_idx ON suppliers(dealer_id);
CREATE INDEX IF NOT EXISTS parts_dealer_barcode_idx ON parts(dealer_id,barcode);
CREATE INDEX IF NOT EXISTS purchase_orders_dealer_review_idx ON purchase_orders(dealer_id,status,location_id);
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='suppliers_lead_time_ck') THEN
  ALTER TABLE suppliers ADD CONSTRAINT suppliers_lead_time_ck CHECK(lead_time_days >= 0);
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='parts_inventory_config_ck') THEN
  ALTER TABLE parts ADD CONSTRAINT parts_inventory_config_ck CHECK(costing_method IN ('average','fifo','landed') AND reorder_max >= 0);
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='purchase_orders_inventory_source_ck') THEN
  ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_inventory_source_ck CHECK(source IN ('manual','low_stock_alert','special_order') AND send_count >= 0);
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inventory_bins_code_ck') THEN
  ALTER TABLE inventory_bins ADD CONSTRAINT inventory_bins_code_ck CHECK(length(trim(code)) > 0);
 END IF;
END $$;
COMMIT;