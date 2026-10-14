ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS engine_displacement_cc integer;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vehicles_engine_displacement_nonnegative') THEN
    ALTER TABLE vehicles ADD CONSTRAINT vehicles_engine_displacement_nonnegative
      CHECK (engine_displacement_cc IS NULL OR engine_displacement_cc >= 0);
  END IF;
END $$;
