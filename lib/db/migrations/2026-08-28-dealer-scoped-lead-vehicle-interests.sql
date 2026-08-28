-- Task 255: additive multi-vehicle lead demand and itemized quote/deal snapshots.
-- Existing primary columns remain authoritative compatibility projections.
CREATE TABLE IF NOT EXISTS lead_vehicle_interests (
  id serial PRIMARY KEY,
  dealer_id integer NOT NULL,
  lead_id integer NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  vehicle_id integer NOT NULL,
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  position integer NOT NULL DEFAULT 0 CHECK (position >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lead_id, vehicle_id),
  UNIQUE (lead_id, position)
);
CREATE INDEX IF NOT EXISTS lead_vehicle_interests_dealer_lead_idx
  ON lead_vehicle_interests (dealer_id, lead_id);

-- Preserve all existing demand as position zero before new callers start
-- writing the normalized representation. ON CONFLICT makes retry safe.
INSERT INTO lead_vehicle_interests (dealer_id, lead_id, vehicle_id, quantity, position)
SELECT dealer_id, id, interested_vehicle_id, 1, 0
FROM leads
WHERE interested_vehicle_id IS NOT NULL
ON CONFLICT (lead_id, vehicle_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS quote_items (
  id serial PRIMARY KEY,
  dealer_id integer NOT NULL,
  quote_id integer NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  vehicle_id integer NOT NULL,
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  position integer NOT NULL DEFAULT 0 CHECK (position >= 0),
  model_year integer NOT NULL,
  vehicle_line text NOT NULL,
  trim text,
  color text,
  manufacturer text NOT NULL,
  base_price double precision NOT NULL,
  tax_lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  total_tax double precision NOT NULL DEFAULT 0,
  total double precision NOT NULL,
  UNIQUE (quote_id, position)
);
CREATE INDEX IF NOT EXISTS quote_items_dealer_quote_idx ON quote_items (dealer_id, quote_id);

CREATE TABLE IF NOT EXISTS deal_items (
  id serial PRIMARY KEY,
  dealer_id integer NOT NULL,
  deal_id integer NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  quote_item_id integer,
  vehicle_id integer NOT NULL,
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  position integer NOT NULL DEFAULT 0 CHECK (position >= 0),
  vehicle_price double precision NOT NULL,
  discount double precision NOT NULL DEFAULT 0,
  tax_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  total double precision NOT NULL,
  status text NOT NULL DEFAULT 'open',
  UNIQUE (deal_id, position)
);
CREATE INDEX IF NOT EXISTS deal_items_dealer_deal_idx ON deal_items (dealer_id, deal_id);

ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS deal_item_id integer;

-- Backfill a compatibility item for historical deals and link existing
-- deliveries to it. No existing invoice/deal/delivery values are changed.
INSERT INTO deal_items (
  dealer_id, deal_id, vehicle_id, quantity, position, vehicle_price, discount, tax_snapshot, total
)
SELECT d.dealer_id, d.id, d.vehicle_id, 1, 0, d.vehicle_price, d.discount,
       COALESCE(d.tax_snapshot, '[]'::jsonb), d.otd_price
FROM deals d
WHERE NOT EXISTS (SELECT 1 FROM deal_items i WHERE i.deal_id = d.id);

UPDATE deliveries dl
SET deal_item_id = i.id
FROM deal_items i
WHERE dl.deal_id = i.deal_id
  AND i.position = 0
  AND dl.deal_item_id IS NULL;

CREATE INDEX IF NOT EXISTS deliveries_dealer_deal_item_idx
  ON deliveries (dealer_id, deal_item_id);