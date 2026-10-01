-- Additive DEVELOPMENT migration. Publish owns managed production schema changes.
ALTER TABLE dealers ADD COLUMN IF NOT EXISTS test_drives_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE dealers ADD COLUMN IF NOT EXISTS whatsapp_showroom_address text;
-- Supplied shop information: GT Automotive only. Do not replace edits or
-- apply this address to Beharry/CAM/other dealerships.
UPDATE dealers
SET whatsapp_showroom_address = '220 Camp St, Georgetown'
WHERE id = 1 AND name = 'GT Automotive'
  AND address = '220 Camp Street, Georgetown, Guyana.'
  AND whatsapp_showroom_address IS NULL;