-- Compatibility backfill for quote revisions created before item snapshots.
-- Legacy quote.base_price is the aggregate subtotal even when quote.quantity
-- is greater than one. Preserve physical quantity while deriving unit price,
-- so base_price * quantity, tax, and total exactly equal the frozen header.
INSERT INTO quote_items (
  dealer_id,
  quote_id,
  vehicle_id,
  quantity,
  position,
  model_year,
  vehicle_line,
  trim,
  color,
  manufacturer,
  base_price,
  tax_lines,
  total_tax,
  total
)
SELECT
  q.dealer_id,
  q.id,
  q.vehicle_id,
  GREATEST(q.quantity, 1),
  0,
  q.model_year,
  q.vehicle_line,
  q.trim,
  q.color,
  q.manufacturer,
  q.base_price / GREATEST(q.quantity, 1),
  q.tax_lines,
  q.total_tax,
  q.total
FROM quotes q
WHERE NOT EXISTS (
  SELECT 1
  FROM quote_items qi
  WHERE qi.quote_id = q.id
);