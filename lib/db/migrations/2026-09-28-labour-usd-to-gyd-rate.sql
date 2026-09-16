-- Labour-only pricing input. Existing GYD money and the deprecated
-- dealers.usd_exchange_rate compatibility field are intentionally untouched.
ALTER TABLE dealer_service_settings
  ADD COLUMN IF NOT EXISTS labour_usd_to_gyd_rate double precision NOT NULL DEFAULT 209;
