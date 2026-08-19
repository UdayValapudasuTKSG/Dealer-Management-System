-- Additive WhatsApp delivery-state and outside-window template support.
-- Idempotent and safe to apply to populated development/production databases.
BEGIN;

ALTER TABLE whatsapp_channels
  ADD COLUMN IF NOT EXISTS service_template_name text,
  ADD COLUMN IF NOT EXISTS service_template_language text NOT NULL DEFAULT 'en_US';

ALTER TABLE whatsapp_messages
  ADD COLUMN IF NOT EXISTS outbox_id integer,
  ADD COLUMN IF NOT EXISTS provider_message_id text,
  ADD COLUMN IF NOT EXISTS delivery_status text NOT NULL DEFAULT 'received',
  ADD COLUMN IF NOT EXISTS delivery_error text,
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz,
  ADD COLUMN IF NOT EXISTS read_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE email_logs
  ADD COLUMN IF NOT EXISTS provider_message_id text,
  ADD COLUMN IF NOT EXISTS delivery_status text,
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz,
  ADD COLUMN IF NOT EXISTS read_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_messages_outbox_uq
  ON whatsapp_messages (outbox_id);

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_messages_provider_message_uq
  ON whatsapp_messages (provider_message_id);

CREATE UNIQUE INDEX IF NOT EXISTS email_logs_provider_message_uq
  ON email_logs (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

COMMIT;