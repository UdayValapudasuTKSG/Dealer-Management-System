-- ERPNext integration foundation: per-dealer connection credentials, the
-- durable outbound sync-job queue, generic external-reference mapping, and
-- the inbound webhook event ledger.
-- Additive; safe to re-run (IF NOT EXISTS everywhere).

CREATE TABLE IF NOT EXISTS erpnext_connections (
  id serial PRIMARY KEY,
  dealer_id integer NOT NULL,
  site_url text NOT NULL,
  api_key text NOT NULL,
  api_secret text NOT NULL,
  webhook_secret text NOT NULL,
  enabled boolean DEFAULT true NOT NULL,
  last_status text,
  last_error text,
  last_checked_at timestamp with time zone,
  company_name text,
  erpnext_version text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS erpnext_connections_dealer_uq
  ON erpnext_connections (dealer_id);

CREATE TABLE IF NOT EXISTS erpnext_sync_jobs (
  id serial PRIMARY KEY,
  dealer_id integer NOT NULL,
  direction text DEFAULT 'outbound' NOT NULL,
  doctype text NOT NULL,
  operation text DEFAULT 'insert' NOT NULL,
  entity_type text NOT NULL,
  entity_id integer NOT NULL,
  payload jsonb DEFAULT '{}'::jsonb NOT NULL,
  dedupe_key text UNIQUE,
  status text DEFAULT 'queued' NOT NULL,
  attempts integer DEFAULT 0 NOT NULL,
  last_error text,
  erpnext_doc_name text,
  next_attempt_at timestamp with time zone,
  completed_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS erpnext_sync_jobs_status_idx
  ON erpnext_sync_jobs (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS erpnext_sync_jobs_dealer_idx
  ON erpnext_sync_jobs (dealer_id, created_at);

CREATE TABLE IF NOT EXISTS erpnext_refs (
  id serial PRIMARY KEY,
  dealer_id integer NOT NULL,
  entity_type text NOT NULL,
  entity_id integer NOT NULL,
  doctype text NOT NULL,
  doc_name text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS erpnext_refs_entity_uq
  ON erpnext_refs (dealer_id, entity_type, entity_id, doctype);
CREATE INDEX IF NOT EXISTS erpnext_refs_doc_idx
  ON erpnext_refs (dealer_id, doctype, doc_name);

CREATE TABLE IF NOT EXISTS erpnext_webhook_events (
  id serial PRIMARY KEY,
  dealer_id integer NOT NULL,
  doctype text,
  doc_name text,
  event text,
  payload jsonb DEFAULT '{}'::jsonb NOT NULL,
  status text DEFAULT 'received' NOT NULL,
  error text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS erpnext_webhook_events_dealer_idx
  ON erpnext_webhook_events (dealer_id, created_at);
