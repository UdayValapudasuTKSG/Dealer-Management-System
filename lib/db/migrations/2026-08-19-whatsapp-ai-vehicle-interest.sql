-- WhatsApp AI concierge: retain an inventory choice while gathering contact details.
-- Idempotent; run once against each environment before deploying the AI flow.
BEGIN;

ALTER TABLE whatsapp_conversations
  ADD COLUMN IF NOT EXISTS interested_vehicle_id integer;

COMMIT;