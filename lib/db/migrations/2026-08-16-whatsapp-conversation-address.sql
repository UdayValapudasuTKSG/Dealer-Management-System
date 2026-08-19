-- WhatsApp guided bot: new "address" step between email and vehicle.
-- Idempotent; already applied to dev. Run once against each environment.
BEGIN;

-- Customer address captured by the WhatsApp lead-capture bot (skippable);
-- copied onto the created lead's address column.
ALTER TABLE whatsapp_conversations
  ADD COLUMN IF NOT EXISTS address text;

COMMIT;
