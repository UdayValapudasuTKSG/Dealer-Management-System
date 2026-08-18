-- ERPNext parts & purchasing sync: per-dealer default warehouse for
-- Stock Entries / Purchase Receipts. Additive, safe on populated tables.
ALTER TABLE erpnext_connections
  ADD COLUMN IF NOT EXISTS default_warehouse text;
