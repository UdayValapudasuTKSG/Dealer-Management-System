-- Vehicle model GL codes (Task: Finance vehicle-model GL mapping).
-- Additive + idempotent: one dealership-scoped GL code per normalized
-- make/model, with per-dealer uniqueness of both the model key and the code.
CREATE TABLE IF NOT EXISTS vehicle_model_gl_codes (
  id serial PRIMARY KEY,
  dealer_id integer NOT NULL,
  make_key text NOT NULL,
  model_key text NOT NULL,
  make_label text NOT NULL,
  model_label text NOT NULL,
  gl_code text NOT NULL,
  account_name text,
  erpnext_status text,
  erpnext_checked_at timestamptz,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS vehicle_model_gl_codes_model_uq
  ON vehicle_model_gl_codes (dealer_id, make_key, model_key);

CREATE UNIQUE INDEX IF NOT EXISTS vehicle_model_gl_codes_code_uq
  ON vehicle_model_gl_codes (dealer_id, gl_code);
