-- Dealer-scoped job-card part requisitions. Re-runnable and tracked in the
-- application migration ledger so development/prod can prove application.
CREATE TABLE IF NOT EXISTS aura_schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS part_requisitions (
  id serial PRIMARY KEY,
  dealer_id integer NOT NULL,
  service_order_id integer NOT NULL,
  job_card_id integer NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,
  requester_user_id integer,
  requester_name text NOT NULL,
  status text NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted','approved','rejected','ordered','partially_fulfilled','fulfilled','cancelled')),
  urgency text NOT NULL DEFAULT 'routine'
    CHECK (urgency IN ('routine','urgent','vehicle_down')),
  need_by date,
  notes text,
  decision_reason text,
  decided_by_user_id integer,
  decided_by_name text,
  decided_at timestamptz,
  ordered_by_user_id integer,
  ordered_by_name text,
  ordered_at timestamptz,
  order_reference text,
  fulfilled_by_user_id integer,
  fulfilled_by_name text,
  fulfilled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS part_requisitions_dealer_status_idx ON part_requisitions(dealer_id,status);
CREATE INDEX IF NOT EXISTS part_requisitions_dealer_job_card_idx ON part_requisitions(dealer_id,job_card_id);
CREATE INDEX IF NOT EXISTS part_requisitions_dealer_service_order_idx ON part_requisitions(dealer_id,service_order_id);

CREATE TABLE IF NOT EXISTS part_requisition_lines (
  id serial PRIMARY KEY,
  dealer_id integer NOT NULL,
  requisition_id integer NOT NULL REFERENCES part_requisitions(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('INTERNAL','EXTERNAL')),
  part_id integer REFERENCES parts(id),
  sku_snapshot text,
  description_snapshot text NOT NULL,
  supplier_snapshot text,
  quantity integer NOT NULL CHECK (quantity > 0),
  fulfilled_quantity integer NOT NULL DEFAULT 0 CHECK (fulfilled_quantity >= 0 AND fulfilled_quantity <= quantity),
  unit_cost double precision NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  unit_price double precision NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  tax_cost double precision NOT NULL DEFAULT 0 CHECK (tax_cost >= 0),
  freight_cost double precision NOT NULL DEFAULT 0 CHECK (freight_cost >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((source = 'INTERNAL' AND part_id IS NOT NULL AND sku_snapshot IS NOT NULL)
      OR (source = 'EXTERNAL' AND part_id IS NULL))
);
CREATE INDEX IF NOT EXISTS part_requisition_lines_req_idx ON part_requisition_lines(dealer_id,requisition_id);
CREATE INDEX IF NOT EXISTS part_requisition_lines_part_idx ON part_requisition_lines(dealer_id,part_id);

CREATE TABLE IF NOT EXISTS part_requisition_fulfillments (
  id serial PRIMARY KEY,
  dealer_id integer NOT NULL,
  requisition_id integer NOT NULL REFERENCES part_requisitions(id) ON DELETE CASCADE,
  line_id integer NOT NULL REFERENCES part_requisition_lines(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  job_card_part_id integer,
  external_job_card_part_id integer,
  fulfilled_by_user_id integer,
  fulfilled_by_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS part_req_fulfillment_idempotency_unique
  ON part_requisition_fulfillments(dealer_id,requisition_id,line_id,idempotency_key);

CREATE TABLE IF NOT EXISTS external_job_card_parts (
  id serial PRIMARY KEY,
  dealer_id integer NOT NULL,
  job_card_id integer NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,
  requisition_line_id integer NOT NULL REFERENCES part_requisition_lines(id),
  fulfillment_id integer NOT NULL,
  description text NOT NULL,
  supplier_snapshot text,
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_cost double precision NOT NULL DEFAULT 0,
  unit_price double precision NOT NULL DEFAULT 0,
  tax_cost double precision NOT NULL DEFAULT 0,
  freight_cost double precision NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS external_job_card_parts_fulfillment_unique
  ON external_job_card_parts(fulfillment_id);
CREATE INDEX IF NOT EXISTS external_job_card_parts_card_idx
  ON external_job_card_parts(dealer_id,job_card_id);

ALTER TABLE service_invoices
  ADD COLUMN IF NOT EXISTS external_parts_total double precision NOT NULL DEFAULT 0;

INSERT INTO aura_schema_migrations(name)
VALUES ('2026-09-19-job-card-part-requisitions')
ON CONFLICT (name) DO NOTHING;