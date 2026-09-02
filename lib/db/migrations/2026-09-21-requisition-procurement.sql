-- Quantity-level requisition → procurement trace and receipt idempotency.
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';

ALTER TABLE part_requisitions ADD COLUMN IF NOT EXISTS cancellation_reason text;
ALTER TABLE part_requisitions ADD COLUMN IF NOT EXISTS cancelled_by_user_id integer;
ALTER TABLE part_requisitions ADD COLUMN IF NOT EXISTS cancelled_by_name text;
ALTER TABLE part_requisitions ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

ALTER TABLE part_requisitions DROP CONSTRAINT IF EXISTS part_requisitions_status_check;
ALTER TABLE part_requisitions
  ADD CONSTRAINT part_requisitions_status_check
  CHECK (
    status IN (
      'submitted',
      'approved',
      'partially_ordered',
      'rejected',
      'ordered',
      'partially_fulfilled',
      'fulfilled',
      'cancelled'
    )
  );

ALTER TABLE purchase_order_lines ALTER COLUMN part_id DROP NOT NULL;
ALTER TABLE purchase_order_lines ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'INTERNAL';

CREATE INDEX IF NOT EXISTS purchase_order_lines_dealer_po_idx
  ON purchase_order_lines (dealer_id, purchase_order_id);

CREATE TABLE IF NOT EXISTS part_requisition_po_allocations (
  id serial PRIMARY KEY,
  dealer_id integer NOT NULL,
  requisition_id integer NOT NULL REFERENCES part_requisitions(id) ON DELETE CASCADE,
  requisition_line_id integer NOT NULL REFERENCES part_requisition_lines(id) ON DELETE CASCADE,
  supplier_id integer NOT NULL REFERENCES suppliers(id),
  purchase_order_id integer NOT NULL REFERENCES purchase_orders(id),
  purchase_order_line_id integer NOT NULL REFERENCES purchase_order_lines(id),
  idempotency_key text NOT NULL,
  quantity_ordered integer NOT NULL CHECK (quantity_ordered > 0),
  quantity_received integer NOT NULL DEFAULT 0 CHECK (quantity_received >= 0 AND quantity_received <= quantity_ordered),
  external_job_card_part_id integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS part_req_po_alloc_idempotency_unique
  ON part_requisition_po_allocations (dealer_id, requisition_id, requisition_line_id, idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS part_req_po_alloc_po_line_unique
  ON part_requisition_po_allocations (purchase_order_line_id);
CREATE INDEX IF NOT EXISTS part_req_po_alloc_req_line_idx
  ON part_requisition_po_allocations (dealer_id, requisition_id, requisition_line_id);
CREATE INDEX IF NOT EXISTS part_req_po_alloc_po_idx
  ON part_requisition_po_allocations (dealer_id, purchase_order_id);

CREATE TABLE IF NOT EXISTS purchase_order_receipts (
  id serial PRIMARY KEY,
  dealer_id integer NOT NULL,
  purchase_order_id integer NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS purchase_order_receipts_idempotency_unique
  ON purchase_order_receipts (dealer_id, purchase_order_id, idempotency_key);
CREATE INDEX IF NOT EXISTS purchase_order_receipts_po_idx
  ON purchase_order_receipts (dealer_id, purchase_order_id);