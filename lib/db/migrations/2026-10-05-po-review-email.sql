BEGIN;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS reviewed_by integer;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS po_number text;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS review_comment text;
ALTER TABLE purchase_order_lines ADD COLUMN IF NOT EXISTS is_special_order boolean NOT NULL DEFAULT false;
ALTER TABLE purchase_order_lines ADD COLUMN IF NOT EXISTS customer_id integer;
ALTER TABLE purchase_order_lines ADD COLUMN IF NOT EXISTS requisition_line_id integer;
ALTER TABLE purchase_order_lines ADD COLUMN IF NOT EXISTS unit_cost_amount numeric(15,2);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS cc_emails jsonb NOT NULL DEFAULT '[]';
ALTER TABLE part_notification_deliveries ADD COLUMN IF NOT EXISTS location_id integer;
ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS location_id integer;
ALTER TABLE purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_inventory_source_ck;
ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_inventory_source_ck CHECK(source IN ('manual','import','low_stock_alert','special_order') AND send_count >= 0);
CREATE TABLE IF NOT EXISTS po_email_snapshots (
 id serial PRIMARY KEY, dealer_id integer NOT NULL, location_id integer,
 purchase_order_id integer NOT NULL REFERENCES purchase_orders(id),
 created_by integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 object_path text NOT NULL, sha256 text NOT NULL, filename text NOT NULL,
 email_log_id integer UNIQUE REFERENCES email_logs(id),
 to_address text NOT NULL, cc text NOT NULL DEFAULT '', subject text NOT NULL,
 body_html text NOT NULL, CONSTRAINT po_snapshot_hash_ck CHECK(length(sha256)=64)
);
CREATE INDEX IF NOT EXISTS po_email_snapshots_scope_idx ON po_email_snapshots(dealer_id,location_id,purchase_order_id);
ALTER TABLE po_email_snapshots ADD COLUMN IF NOT EXISTS po_fingerprint text NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS po_communication_settings (
 dealer_id integer NOT NULL, location_id integer NOT NULL REFERENCES inventory_locations(id),
 subject text NOT NULL DEFAULT 'Purchase order {{po_number}}',
 body_html text NOT NULL DEFAULT '<p>Dear {{supplier_name}},</p><p>Please find purchase order {{po_number}} attached for {{branch}}. Expected: {{expected_date}}.</p><p>{{sender_name}}</p>',
 sms_enabled boolean NOT NULL DEFAULT false,
 parts_manager boolean NOT NULL DEFAULT true,
 service_manager boolean NOT NULL DEFAULT true,
 customer_sms boolean NOT NULL DEFAULT false,
 PRIMARY KEY(dealer_id,location_id)
);
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='purchase_orders_review_status_ck') THEN
   ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_review_status_ck
   CHECK (status IN ('draft','pending_review','approved','sent','ordered','partially_received','received','closed','cancelled'));
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='suppliers_cc_emails_ck') THEN
   ALTER TABLE suppliers ADD CONSTRAINT suppliers_cc_emails_ck CHECK(jsonb_typeof(cc_emails)='array');
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS po_branch_counters (
 dealer_id integer NOT NULL, location_id integer NOT NULL,
 last_number bigint NOT NULL DEFAULT 0 CHECK(last_number>=0),
 PRIMARY KEY(dealer_id,location_id)
);
CREATE OR REPLACE FUNCTION assign_branch_po_number() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE next_number bigint;
BEGIN
 IF NEW.po_number IS NULL AND NEW.location_id IS NOT NULL THEN
   INSERT INTO po_branch_counters(dealer_id,location_id,last_number) VALUES(NEW.dealer_id,NEW.location_id,1)
   ON CONFLICT(dealer_id,location_id) DO UPDATE SET last_number=po_branch_counters.last_number+1 RETURNING last_number INTO next_number;
   NEW.po_number := 'PO-' || NEW.location_id || '-' || lpad(next_number::text,6,'0');
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS purchase_orders_branch_number ON purchase_orders;
CREATE TRIGGER purchase_orders_branch_number BEFORE INSERT ON purchase_orders FOR EACH ROW EXECUTE FUNCTION assign_branch_po_number();
CREATE UNIQUE INDEX IF NOT EXISTS purchase_orders_branch_number_uq ON purchase_orders(dealer_id,location_id,po_number) WHERE po_number IS NOT NULL;
CREATE OR REPLACE FUNCTION preserve_po_line_decimal_amount() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' OR NEW.unit_cost IS DISTINCT FROM OLD.unit_cost THEN
   NEW.unit_cost_amount := round(NEW.unit_cost::numeric,2);
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS po_line_decimal_amount ON purchase_order_lines;
CREATE TRIGGER po_line_decimal_amount BEFORE INSERT OR UPDATE OF unit_cost ON purchase_order_lines FOR EACH ROW EXECUTE FUNCTION preserve_po_line_decimal_amount();
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='po_line_decimal_amount_ck') THEN
    ALTER TABLE purchase_order_lines ADD CONSTRAINT po_line_decimal_amount_ck CHECK(unit_cost_amount IS NULL OR unit_cost_amount>=0);
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS parts_module_migrations (
 name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM parts_module_migrations WHERE name='2026-10-05-po-review-email') THEN
   UPDATE purchase_order_lines l SET is_special_order=true
   FROM purchase_orders p WHERE p.id=l.purchase_order_id AND p.dealer_id=l.dealer_id AND p.source='special_order';
   INSERT INTO parts_module_migrations(name) VALUES('2026-10-05-po-review-email');
 END IF;
END $$;
-- Also finish validation for development databases that ran the earlier version.
-- Leave the data and CHECK predicates unchanged; fail rather than rewrite bad rows.
-- Publish introspects these definitions, so do not leave staging NOT VALID flags.
ALTER TABLE purchase_orders VALIDATE CONSTRAINT purchase_orders_inventory_source_ck;
ALTER TABLE purchase_orders VALIDATE CONSTRAINT purchase_orders_review_status_ck;
ALTER TABLE purchase_order_lines VALIDATE CONSTRAINT po_line_decimal_amount_ck;
COMMIT;