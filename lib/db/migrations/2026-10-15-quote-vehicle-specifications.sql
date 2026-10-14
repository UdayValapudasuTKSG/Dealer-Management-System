-- Preserve technical specifications with each commercial quote revision.
ALTER TABLE quote_items ADD COLUMN IF NOT EXISTS engine_displacement_cc integer;
ALTER TABLE quote_items ADD COLUMN IF NOT EXISTS transmission text;
ALTER TABLE quote_items ADD COLUMN IF NOT EXISTS fuel_type text;
