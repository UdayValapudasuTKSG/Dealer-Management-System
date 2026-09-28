-- Restore the original 20 MB cap without modifying or deleting any brochure.
-- A validated CHECK cannot be installed while an existing brochure exceeds it.
-- Fail explicitly in that case; the application still limits all new uploads.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM dealer_brochures WHERE size_bytes > 20971520) THEN
    RAISE EXCEPTION 'Cannot restore validated 20 MB brochure CHECK: existing brochures exceed 20971520 bytes. Preserve those rows; new uploads are limited by the application.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'dealer_brochures'::regclass
      AND conname = 'dealer_brochures_size_bytes_check'
      AND convalidated
      AND pg_get_constraintdef(oid) ~ '20971520'
  ) THEN
    RETURN;
  END IF;
  ALTER TABLE dealer_brochures DROP CONSTRAINT IF EXISTS dealer_brochures_size_bytes_check;
  ALTER TABLE dealer_brochures ADD CONSTRAINT dealer_brochures_size_bytes_check
    CHECK (size_bytes > 0 AND size_bytes <= 20971520);
END $$;