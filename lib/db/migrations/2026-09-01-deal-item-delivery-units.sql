-- Task 255 completion: one delivery/VIN allocation for every committed unit.
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS deal_item_unit integer;

-- Historical deliveries represent the first unit of their linked item.
UPDATE deliveries
SET deal_item_unit = 0
WHERE deal_item_id IS NOT NULL AND deal_item_unit IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS deliveries_deal_item_unit_uq
  ON deliveries (deal_item_id, deal_item_unit)
  WHERE deal_item_id IS NOT NULL AND deal_item_unit IS NOT NULL;