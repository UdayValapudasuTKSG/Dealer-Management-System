-- Meta Lead Ads page-to-dealer mapping (Task: Connect Meta Business Suite).
-- Idempotent; already applied to dev. Run once against each environment.
BEGIN;

-- Facebook Page ID that routes Meta Lead Ads webhook events to this dealer.
-- NULL = not connected. Unmapped page ids are rejected by the webhook
-- (fail closed, no lead write).
ALTER TABLE dealers
  ADD COLUMN IF NOT EXISTS meta_page_id text;

-- Tenant routing must be deterministic: one Facebook Page can belong to at
-- most one dealer. Partial unique index so many dealers can stay unmapped.
CREATE UNIQUE INDEX IF NOT EXISTS dealers_meta_page_id_idx
  ON dealers (meta_page_id)
  WHERE meta_page_id IS NOT NULL;

-- Webhook idempotency ledger: meta_leadgen rows now stamp the routed dealer
-- so the connection status panel can attribute the last-received lead.
ALTER TABLE webhook_events
  ADD COLUMN IF NOT EXISTS dealer_id integer;

COMMIT;
