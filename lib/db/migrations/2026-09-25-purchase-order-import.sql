BEGIN;
-- Existing supplier records have no external code: expose a stable SUP-<id>
-- reference. Newly added suppliers can likewise be addressed by SUP-<id>.
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS supplier_code text;
UPDATE suppliers SET supplier_code = 'SUP-' || id WHERE supplier_code IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS suppliers_dealer_import_code_unique
  ON suppliers (dealer_id, lower(supplier_code)) WHERE supplier_code IS NOT NULL;

ALTER TABLE purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_inventory_source_ck;
ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_inventory_source_ck
  CHECK (source IN ('manual','low_stock_alert','special_order','import') AND send_count >= 0);

-- Existing unit_cost remains populated for compatibility with the normal PO lifecycle.
-- The imported original amount is retained losslessly in fixed-point decimal.
ALTER TABLE purchase_order_lines ADD COLUMN IF NOT EXISTS import_unit_cost numeric(15,2);

CREATE TABLE IF NOT EXISTS purchase_order_import_commits (
  id bigserial PRIMARY KEY,
  dealer_id integer NOT NULL,
  fingerprint text NOT NULL,
  created_by integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dealer_id, fingerprint)
);
CREATE TABLE IF NOT EXISTS purchase_order_import_sources (
  id bigserial PRIMARY KEY,
  dealer_id integer NOT NULL,
  commit_id bigint NOT NULL REFERENCES purchase_order_import_commits(id),
  purchase_order_id integer NOT NULL REFERENCES purchase_orders(id),
  source_file_name text NOT NULL,
  UNIQUE (purchase_order_id)
);
CREATE TABLE IF NOT EXISTS purchase_order_import_lines (
  id bigserial PRIMARY KEY,
  dealer_id integer NOT NULL,
  source_id bigint NOT NULL REFERENCES purchase_order_import_sources(id),
  purchase_order_line_id integer NOT NULL REFERENCES purchase_order_lines(id),
  source_row_number integer NOT NULL,
  UNIQUE (purchase_order_line_id),
  UNIQUE (source_id, source_row_number)
);
COMMIT;