-- Additive customer billing provenance and fixed-point non-tax charges.
CREATE TABLE IF NOT EXISTS parts_estimate_charges (
  dealer_id integer NOT NULL,
  job_card_id integer NOT NULL REFERENCES job_cards(id),
  shipping_amount numeric(18,2) NOT NULL DEFAULT 0 CHECK (shipping_amount >= 0),
  duties_amount numeric(18,2) NOT NULL DEFAULT 0 CHECK (duties_amount >= 0),
  updated_by integer,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dealer_id, job_card_id)
);
CREATE TABLE IF NOT EXISTS parts_invoice_sources (
  id serial PRIMARY KEY,
  dealer_id integer NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('requisition','special_order')),
  source_id integer NOT NULL,
  customer_id integer NOT NULL REFERENCES customers(id),
  invoice_id integer NOT NULL REFERENCES invoices(id),
  shipping_amount numeric(18,2) NOT NULL DEFAULT 0,
  duties_amount numeric(18,2) NOT NULL DEFAULT 0,
  lines jsonb NOT NULL,
  created_by integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dealer_id, source_type, source_id)
);
CREATE TABLE IF NOT EXISTS service_invoice_parts_charges (
  dealer_id integer NOT NULL,
  invoice_id integer NOT NULL REFERENCES service_invoices(id),
  shipping_amount numeric(18,2) NOT NULL DEFAULT 0,
  duties_amount numeric(18,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (dealer_id, invoice_id)
);
CREATE TABLE IF NOT EXISTS parts_billed_requisition_lines (
  dealer_id integer NOT NULL,
  requisition_line_id integer NOT NULL REFERENCES part_requisition_lines(id),
  invoice_id integer NOT NULL REFERENCES invoices(id),
  PRIMARY KEY (dealer_id, requisition_line_id)
);
CREATE TABLE IF NOT EXISTS parts_deposit_allocations (
  id serial PRIMARY KEY,
  dealer_id integer NOT NULL,
  customer_id integer NOT NULL REFERENCES customers(id),
  deposit_invoice_id integer NOT NULL REFERENCES invoices(id),
  invoice_id integer NOT NULL REFERENCES invoices(id),
  amount numeric(18,2) NOT NULL CHECK (amount > 0),
  debit_payment_id integer NOT NULL REFERENCES payments(id),
  credit_payment_id integer NOT NULL REFERENCES payments(id),
  authorized_by integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dealer_id, invoice_id),
  CHECK (deposit_invoice_id <> invoice_id)
);
CREATE TABLE IF NOT EXISTS parts_billed_job_lines (
  dealer_id integer NOT NULL,
  job_card_part_id integer NOT NULL REFERENCES job_card_parts(id),
  invoice_id integer NOT NULL REFERENCES invoices(id),
  PRIMARY KEY (dealer_id, job_card_part_id)
);