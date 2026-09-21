-- DEVELOPMENT ONLY. Preserve every record and establish tenant uniqueness before
-- removing the obsolete global SKU constraint. Re-runnable tracked schema change.
BEGIN;
CREATE UNIQUE INDEX IF NOT EXISTS parts_dealer_sku_unique ON parts(dealer_id, sku);
ALTER TABLE parts DROP CONSTRAINT IF EXISTS parts_sku_unique;
COMMIT;