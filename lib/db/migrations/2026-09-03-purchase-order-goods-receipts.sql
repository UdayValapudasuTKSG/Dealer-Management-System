ALTER TABLE purchase_order_receipts
  ADD COLUMN IF NOT EXISTS received_at timestamptz,
  ADD COLUMN IF NOT EXISTS received_by_user_id integer,
  ADD COLUMN IF NOT EXISTS received_by_name text,
  ADD COLUMN IF NOT EXISTS delivery_note_number text,
  ADD COLUMN IF NOT EXISTS supplier_invoice_number text,
  ADD COLUMN IF NOT EXISTS warehouse_location text,
  ADD COLUMN IF NOT EXISTS condition text,
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS documents jsonb NOT NULL DEFAULT '[]'::jsonb;

UPDATE purchase_order_receipts
SET received_at = COALESCE(received_at, created_at),
    received_by_name = COALESCE(received_by_name, 'Parts'),
    delivery_note_number = COALESCE(delivery_note_number, 'Legacy receipt'),
    warehouse_location = COALESCE(warehouse_location, 'Parts stores'),
    condition = COALESCE(condition, 'accepted');

ALTER TABLE purchase_order_receipts
  ALTER COLUMN received_at SET NOT NULL,
  ALTER COLUMN received_by_name SET NOT NULL,
  ALTER COLUMN delivery_note_number SET NOT NULL,
  ALTER COLUMN warehouse_location SET NOT NULL,
  ALTER COLUMN condition SET NOT NULL;