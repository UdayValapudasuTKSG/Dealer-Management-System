-- Additive migration. Execute only through guarded migrate-supplier-invoices.ts.
CREATE TABLE IF NOT EXISTS supplier_invoices (
 id serial PRIMARY KEY, dealer_id integer NOT NULL, location_id integer NOT NULL REFERENCES inventory_locations(id),
 supplier_id integer NOT NULL REFERENCES suppliers(id), po_id integer NOT NULL REFERENCES purchase_orders(id),
 invoice_number text NOT NULL CHECK(length(trim(invoice_number)) > 0), invoice_date date NOT NULL,
 object_path text NOT NULL, file_name text NOT NULL,
 subtotal_minor bigint NOT NULL CHECK(subtotal_minor >= 0), shipping_minor bigint NOT NULL CHECK(shipping_minor >= 0),
 duties_minor bigint NOT NULL CHECK(duties_minor >= 0), tax_minor bigint NOT NULL CHECK(tax_minor >= 0),
 total_minor bigint NOT NULL CHECK(total_minor = subtotal_minor + shipping_minor + duties_minor + tax_minor),
 tolerance_bps integer NOT NULL DEFAULT 0 CHECK(tolerance_bps BETWEEN 0 AND 10000),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','reconciled')),
 created_by integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), reconciled_by integer, reconciled_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS supplier_invoice_number_uq ON supplier_invoices(dealer_id,supplier_id,lower(trim(invoice_number)));
CREATE INDEX IF NOT EXISTS supplier_invoice_po_idx ON supplier_invoices(dealer_id,po_id,status);
CREATE TABLE IF NOT EXISTS supplier_invoice_lines (
 id serial PRIMARY KEY, invoice_id integer NOT NULL REFERENCES supplier_invoices(id), po_line_id integer REFERENCES purchase_order_lines(id),
 part_number text NOT NULL, description text NOT NULL, quantity integer NOT NULL CHECK(quantity >= 0),
 unit_cost_minor bigint NOT NULL CHECK(unit_cost_minor >= 0), allocated_minor bigint,
 match_status jsonb NOT NULL DEFAULT '[]', accepted_reason text, accepted_by integer, accepted_at timestamptz, accepted_snapshot jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS supplier_invoice_line_once_uq ON supplier_invoice_lines(invoice_id,po_line_id);
CREATE TABLE IF NOT EXISTS supplier_invoice_part_costs (
 dealer_id integer NOT NULL, part_id integer NOT NULL REFERENCES parts(id), last_cost_minor bigint NOT NULL,
 invoice_id integer NOT NULL REFERENCES supplier_invoices(id), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(dealer_id,part_id)
);
CREATE TABLE IF NOT EXISTS supplier_invoice_cost_allocations (
 id serial PRIMARY KEY, invoice_line_id integer NOT NULL REFERENCES supplier_invoice_lines(id),
 layer_id integer NOT NULL REFERENCES inventory_cost_layers(id), quantity integer NOT NULL CHECK(quantity>0),
 landed_minor bigint NOT NULL CHECK(landed_minor>=0), quantity_remaining_at_reconcile integer NOT NULL CHECK(quantity_remaining_at_reconcile>=0),
 UNIQUE(invoice_line_id,layer_id)
);