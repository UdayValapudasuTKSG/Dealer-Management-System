-- Task 263: multi-unit reservation soft locks.
-- A fully paid reservation invoice temporarily holds one distinct VIN per
-- requested deal-item unit until final commitment adopts or releases them.

CREATE TABLE IF NOT EXISTS reservation_allocations (
  id serial PRIMARY KEY,
  dealer_id integer NOT NULL,
  deal_id integer NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  invoice_id integer,
  deal_item_id integer NOT NULL REFERENCES deal_items(id) ON DELETE CASCADE,
  deal_item_unit integer NOT NULL,
  vehicle_id integer NOT NULL,
  status text NOT NULL DEFAULT 'active',
  expires_at timestamptz,
  released_reason text,
  released_at timestamptz,
  finalized_at timestamptz,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One active hold per deal-item unit, and per physical vehicle.
CREATE UNIQUE INDEX IF NOT EXISTS reservation_allocations_item_unit_active_uq
  ON reservation_allocations (deal_item_id, deal_item_unit)
  WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS reservation_allocations_vehicle_active_uq
  ON reservation_allocations (vehicle_id)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS reservation_allocations_dealer_deal_idx
  ON reservation_allocations (dealer_id, deal_id);

-- Visible reservation-inventory state on the deal: null | 'held' | 'unfulfilled'.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS reservation_hold_status text;

-- Backfill ONLY unambiguous legacy paid single-unit reservations: a paid
-- active booking whose deal has exactly one single-quantity item, no
-- delivery allocation yet, and whose booked vehicle isn't otherwise claimed.
INSERT INTO reservation_allocations
  (dealer_id, deal_id, invoice_id, deal_item_id, deal_item_unit, vehicle_id,
   status, expires_at, created_by)
SELECT b.dealer_id, b.deal_id, NULL, di.id, 0, b.vehicle_id,
       'active', b.expires_at, 'migration-2026-09-04'
FROM bookings b
JOIN deals d ON d.id = b.deal_id AND d.dealer_id = b.dealer_id
JOIN deal_items di ON di.deal_id = d.id AND di.dealer_id = d.dealer_id
WHERE b.status = 'active'
  AND b.payment_status = 'paid'
  AND b.deal_id IS NOT NULL
  AND d.stage = 'desking'
  AND di.quantity = 1
  AND (SELECT count(*) FROM deal_items di2
        WHERE di2.deal_id = d.id AND di2.dealer_id = d.dealer_id) = 1
  AND NOT EXISTS (SELECT 1 FROM deliveries dv
        WHERE dv.deal_id = d.id AND dv.dealer_id = d.dealer_id
          AND dv.status <> 'cancelled')
  AND NOT EXISTS (SELECT 1 FROM reservation_allocations ra
        WHERE ra.deal_item_id = di.id AND ra.status = 'active')
  AND NOT EXISTS (SELECT 1 FROM reservation_allocations ra2
        WHERE ra2.vehicle_id = b.vehicle_id AND ra2.status = 'active');

UPDATE deals d SET reservation_hold_status = 'held'
WHERE d.reservation_hold_status IS NULL
  AND EXISTS (SELECT 1 FROM reservation_allocations ra
        WHERE ra.deal_id = d.id AND ra.status = 'active');
