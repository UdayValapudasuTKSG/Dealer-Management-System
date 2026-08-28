-- Spec-level demand: selecting an interest never selects or reserves a VIN.
-- All statements are additive/idempotent and retain unit ids only as legacy
-- provenance for historical rows.
ALTER TABLE lead_vehicle_interests ALTER COLUMN vehicle_id DROP NOT NULL;
ALTER TABLE lead_vehicle_interests ADD COLUMN IF NOT EXISTS make text;
ALTER TABLE lead_vehicle_interests ADD COLUMN IF NOT EXISTS model text;
ALTER TABLE lead_vehicle_interests ADD COLUMN IF NOT EXISTS model_year integer;
ALTER TABLE lead_vehicle_interests ADD COLUMN IF NOT EXISTS variant text;
ALTER TABLE lead_vehicle_interests ADD COLUMN IF NOT EXISTS color text;
ALTER TABLE lead_vehicle_interests ADD COLUMN IF NOT EXISTS unit_price double precision;

UPDATE lead_vehicle_interests i
SET make = COALESCE(i.make, v.make),
    model = COALESCE(i.model, v.model),
    model_year = COALESCE(i.model_year, v.year),
    variant = COALESCE(i.variant, v.trim, v.variant),
    color = COALESCE(i.color, v.exterior_color),
    unit_price = COALESCE(i.unit_price, v.price)
FROM vehicles v
WHERE i.vehicle_id = v.id AND i.dealer_id = v.dealer_id
  AND (i.make IS NULL OR i.model IS NULL OR i.model_year IS NULL OR i.unit_price IS NULL);
ALTER TABLE lead_vehicle_interests ALTER COLUMN make SET NOT NULL;
ALTER TABLE lead_vehicle_interests ALTER COLUMN model SET NOT NULL;
ALTER TABLE lead_vehicle_interests ALTER COLUMN model_year SET NOT NULL;
ALTER TABLE lead_vehicle_interests ALTER COLUMN unit_price SET NOT NULL;

ALTER TABLE quote_items ALTER COLUMN vehicle_id DROP NOT NULL;
ALTER TABLE quote_items ADD COLUMN IF NOT EXISTS make text;
ALTER TABLE quote_items ADD COLUMN IF NOT EXISTS model text;
UPDATE quote_items q
SET make = COALESCE(q.make, v.make, q.manufacturer),
    model = COALESCE(q.model, v.model, q.vehicle_line)
FROM vehicles v
WHERE q.vehicle_id = v.id AND q.dealer_id = v.dealer_id AND (q.make IS NULL OR q.model IS NULL);
UPDATE quote_items SET make = manufacturer WHERE make IS NULL;
UPDATE quote_items SET model = vehicle_line WHERE model IS NULL;
ALTER TABLE quote_items ALTER COLUMN make SET NOT NULL;
ALTER TABLE quote_items ALTER COLUMN model SET NOT NULL;

ALTER TABLE deal_items ADD COLUMN IF NOT EXISTS make text;
ALTER TABLE deal_items ALTER COLUMN vehicle_id DROP NOT NULL;
ALTER TABLE deals ALTER COLUMN vehicle_id DROP NOT NULL;
ALTER TABLE deal_items ADD COLUMN IF NOT EXISTS model text;
ALTER TABLE deal_items ADD COLUMN IF NOT EXISTS model_year integer;
ALTER TABLE deal_items ADD COLUMN IF NOT EXISTS variant text;
ALTER TABLE deal_items ADD COLUMN IF NOT EXISTS color text;
UPDATE deal_items i
SET make = COALESCE(i.make, v.make),
    model = COALESCE(i.model, v.model),
    model_year = COALESCE(i.model_year, v.year),
    variant = COALESCE(i.variant, v.trim, v.variant),
    color = COALESCE(i.color, v.exterior_color)
FROM vehicles v
WHERE i.vehicle_id = v.id AND i.dealer_id = v.dealer_id
  AND (i.make IS NULL OR i.model IS NULL OR i.model_year IS NULL);

CREATE INDEX IF NOT EXISTS lead_vehicle_interests_spec_idx
  ON lead_vehicle_interests (dealer_id, make, model, model_year, variant, color);
CREATE INDEX IF NOT EXISTS deal_items_allocation_spec_idx
  ON deal_items (dealer_id, make, model, model_year, variant, color);