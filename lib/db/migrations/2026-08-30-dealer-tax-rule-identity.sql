-- Dealer tax rule identity and conflict-safe default seeding.
-- Preserve the oldest canonical row when a historical race created exact
-- dealer/code/effective-date duplicates.
WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY dealer_id, code, effective_from
    ORDER BY id
  ) AS rn
  FROM dealer_taxes
)
DELETE FROM dealer_taxes
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX IF NOT EXISTS dealer_taxes_dealer_code_effective_uq
  ON dealer_taxes (dealer_id, code, effective_from);