-- Additive only: operational sales finance requests (approval -> durable ERP posting).
CREATE TABLE IF NOT EXISTS sales_finance_requests (
  id serial PRIMARY KEY,
  dealer_id integer NOT NULL,
  deal_id integer NOT NULL,
  invoice_id integer,
  kind text NOT NULL CHECK (kind IN ('invoice','payment','expense')),
  category text CHECK (category IS NULL OR category IN ('registration','fuel','detailing')),
  date text NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  payment_method text,
  source_id text,
  payer_type text,
  reference text NOT NULL,
  evidence text,
  billing_treatment text,
  customer_charge_cents bigint,
  legacy_payment_id integer,
  snapshot jsonb NOT NULL,
  config_revision integer NOT NULL,
  blockers jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','posting','posted','rejected','failed','blocked')),
  requested_by integer NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by integer,
  reviewed_at timestamptz,
  rejection_reason text,
  payment_id integer,
  charge_invoice_id integer,
  erp_job_id integer,
  erp_doctype text,
  erp_doc_name text,
  erp_remote_key text,
  post_attempts integer NOT NULL DEFAULT 0,
  last_error text,
  posted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (reviewed_by IS NULL OR reviewed_by <> requested_by)
);
CREATE INDEX IF NOT EXISTS sales_finance_requests_deal_idx ON sales_finance_requests(dealer_id, deal_id);
CREATE INDEX IF NOT EXISTS sales_finance_requests_status_idx ON sales_finance_requests(dealer_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS sales_finance_requests_payment_uq ON sales_finance_requests(payment_id);
CREATE UNIQUE INDEX IF NOT EXISTS sales_finance_requests_charge_invoice_uq ON sales_finance_requests(charge_invoice_id);
