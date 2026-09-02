-- Token-hashed customer vehicle self-onboarding. Idempotent for tracked runners.
CREATE TABLE IF NOT EXISTS garage_vehicles (
  id serial PRIMARY KEY, dealer_id integer NOT NULL, customer_id integer NOT NULL,
  registration text NOT NULL, vin_chassis text, make text NOT NULL, model text NOT NULL,
  year integer, colour text, mileage integer, notes text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS garage_vehicles_dealer_customer_registration_uq
  ON garage_vehicles (dealer_id, customer_id, registration);

CREATE TABLE IF NOT EXISTS vehicle_onboarding_requests (
  id serial PRIMARY KEY, dealer_id integer NOT NULL, customer_id integer NOT NULL,
  token_hash text NOT NULL, expires_at timestamptz NOT NULL, submitted_at timestamptz,
  garage_vehicle_id integer, invited_by_user_id integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS vehicle_onboarding_requests_token_hash_uq
  ON vehicle_onboarding_requests (token_hash);

CREATE TABLE IF NOT EXISTS vehicle_onboarding_media (
  id serial PRIMARY KEY, request_id integer NOT NULL, dealer_id integer NOT NULL,
  customer_id integer NOT NULL, garage_vehicle_id integer, object_path text NOT NULL,
  kind text NOT NULL, mime_type text NOT NULL, size_bytes integer NOT NULL,
  original_name text, finalized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS vehicle_onboarding_media_object_path_uq
  ON vehicle_onboarding_media (object_path);

DO $$ BEGIN ALTER TABLE garage_vehicles ADD CONSTRAINT garage_vehicles_dealer_fk FOREIGN KEY (dealer_id) REFERENCES dealers(id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE garage_vehicles ADD CONSTRAINT garage_vehicles_customer_fk FOREIGN KEY (customer_id) REFERENCES customers(id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE vehicle_onboarding_requests ADD CONSTRAINT vehicle_onboarding_requests_dealer_fk FOREIGN KEY (dealer_id) REFERENCES dealers(id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE vehicle_onboarding_requests ADD CONSTRAINT vehicle_onboarding_requests_customer_fk FOREIGN KEY (customer_id) REFERENCES customers(id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE vehicle_onboarding_requests ADD CONSTRAINT vehicle_onboarding_requests_vehicle_fk FOREIGN KEY (garage_vehicle_id) REFERENCES garage_vehicles(id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE vehicle_onboarding_media ADD CONSTRAINT vehicle_onboarding_media_request_fk FOREIGN KEY (request_id) REFERENCES vehicle_onboarding_requests(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE vehicle_onboarding_media ADD CONSTRAINT vehicle_onboarding_media_dealer_fk FOREIGN KEY (dealer_id) REFERENCES dealers(id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE vehicle_onboarding_media ADD CONSTRAINT vehicle_onboarding_media_customer_fk FOREIGN KEY (customer_id) REFERENCES customers(id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE vehicle_onboarding_media ADD CONSTRAINT vehicle_onboarding_media_vehicle_fk FOREIGN KEY (garage_vehicle_id) REFERENCES garage_vehicles(id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE vehicle_onboarding_media ADD CONSTRAINT vehicle_onboarding_media_kind_ck
    CHECK (kind IN ('image', 'video'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE vehicle_onboarding_media ADD CONSTRAINT vehicle_onboarding_media_size_ck
    CHECK ((finalized_at IS NULL AND size_bytes = 0) OR
           (finalized_at IS NOT NULL AND size_bytes > 0 AND size_bytes <= 2147483647));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;