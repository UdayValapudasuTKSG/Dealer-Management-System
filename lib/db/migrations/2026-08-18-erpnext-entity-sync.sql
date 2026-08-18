-- ERPNext entity sync (customers, invoices, payments):
-- accounting-mapping config on the connection + customer update tracking
-- for two-way conflict resolution. Additive; safe to re-run.

ALTER TABLE erpnext_connections ADD COLUMN IF NOT EXISTS income_account text;
ALTER TABLE erpnext_connections ADD COLUMN IF NOT EXISTS tax_account text;
ALTER TABLE erpnext_connections ADD COLUMN IF NOT EXISTS payment_modes jsonb;

ALTER TABLE customers ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone DEFAULT now() NOT NULL;

-- Round 2: real ERPNext posting contract + timezone-aware conflict ordering
ALTER TABLE erpnext_connections ADD COLUMN IF NOT EXISTS receivable_account text;
ALTER TABLE erpnext_connections ADD COLUMN IF NOT EXISTS settlement_account text;
ALTER TABLE erpnext_connections ADD COLUMN IF NOT EXISTS site_timezone text;
