-- Upgrade existing brochure tables created with the original 20 MB limit.
-- Safe to repeat; matches the named constraint on new tables.
ALTER TABLE dealer_brochures DROP CONSTRAINT IF EXISTS dealer_brochures_size_bytes_check;
ALTER TABLE dealer_brochures ADD CONSTRAINT dealer_brochures_size_bytes_check
  CHECK (size_bytes > 0 AND size_bytes <= 104857600);