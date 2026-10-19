CREATE TABLE IF NOT EXISTS parts_pos_settings (
 dealer_id integer PRIMARY KEY, revision integer NOT NULL DEFAULT 1,
 config jsonb NOT NULL, validation jsonb NOT NULL, updated_by integer NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS parts_pos_requests (
 id serial PRIMARY KEY, dealer_id integer NOT NULL, kind text NOT NULL,
 status text NOT NULL DEFAULT 'pending', request_key text NOT NULL,
 revision integer NOT NULL, input jsonb NOT NULL, snapshot jsonb NOT NULL,
 created_by integer NOT NULL, decided_by integer, decision_note text, error text,
 erp_documents jsonb NOT NULL DEFAULT '[]'::jsonb,
 reconciliation_reference text, reconciled_by integer, reconciled_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS parts_pos_requests_key_uq ON parts_pos_requests(dealer_id, request_key);
