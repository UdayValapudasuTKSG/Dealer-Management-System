CREATE TABLE IF NOT EXISTS sales_accounting_settings (
  dealer_id integer PRIMARY KEY, config jsonb NOT NULL, vat_policy text NOT NULL DEFAULT 'pending',
  validation jsonb, revision integer NOT NULL DEFAULT 1, updated_by integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sales_accounting_workflows (
  id serial PRIMARY KEY, dealer_id integer NOT NULL, deal_id integer NOT NULL,
  started_by integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sales_accounting_workflow_deal_uq ON sales_accounting_workflows(dealer_id, deal_id);
CREATE TABLE IF NOT EXISTS sales_accounting_entries (
  id serial PRIMARY KEY, dealer_id integer NOT NULL, deal_id integer NOT NULL, stage text NOT NULL,
  input jsonb NOT NULL, state text NOT NULL DEFAULT 'draft', lines jsonb NOT NULL DEFAULT '[]',
  blockers jsonb NOT NULL DEFAULT '[]', revision integer NOT NULL DEFAULT 1,
  config_revision integer, reviewed_by integer, reviewed_at timestamptz,
  updated_by integer NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sales_accounting_entry_stage_uq ON sales_accounting_entries(dealer_id, deal_id, stage);
