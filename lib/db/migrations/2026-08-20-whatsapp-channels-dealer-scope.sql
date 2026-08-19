-- Additive migration: per-dealership Meta WhatsApp channels + dealer-scoped
-- conversations/messages. Idempotent; safe to run multiple times.
BEGIN;

-- 1. Per-dealer Meta WhatsApp channel config (one per dealer).
CREATE TABLE IF NOT EXISTS whatsapp_channels (
  id                     serial PRIMARY KEY,
  dealer_id              integer NOT NULL,
  waba_id                text NOT NULL,
  phone_number_id        text NOT NULL,
  display_phone_number   text,
  verified_name          text,
  enabled                boolean NOT NULL DEFAULT true,
  -- AES-256-GCM ciphertext: <iv_b64>:<tag_b64>:<ciphertext_b64>
  access_token_ciphertext text,
  last_status            text,
  last_error             text,
  last_checked_at        timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_channels_dealer_uq
  ON whatsapp_channels (dealer_id);

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_channels_phone_number_id_uq
  ON whatsapp_channels (phone_number_id);

CREATE INDEX IF NOT EXISTS whatsapp_channels_dealer_idx
  ON whatsapp_channels (dealer_id);

-- 2. Add dealer_id to whatsapp_conversations.
--    Backfill existing rows to dealer 2 (CAM Motors production deployment),
--    then require every future write to provide its dealership explicitly.
ALTER TABLE whatsapp_conversations
  ADD COLUMN IF NOT EXISTS dealer_id integer;

-- Historical conversations came from the single CAM Motors channel. Refuse
-- to assign them unless the existing dealer-scoped transcript proves dealer 2
-- ownership; another deployment must supply its own explicit ownership map.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM whatsapp_conversations WHERE dealer_id IS NULL
  ) AND (
    NOT EXISTS (SELECT 1 FROM dealers WHERE id = 2)
    OR EXISTS (
      SELECT 1
      FROM whatsapp_conversations c
      WHERE c.dealer_id IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM whatsapp_messages m
          WHERE m.phone = c.phone
            AND m.dealer_id = 2
        )
    )
    OR EXISTS (
      SELECT 1
      FROM whatsapp_conversations c
      JOIN whatsapp_messages m ON m.phone = c.phone
      WHERE c.dealer_id IS NULL
        AND m.dealer_id <> 2
    )
  ) THEN
    RAISE EXCEPTION
      'Cannot infer WhatsApp conversation ownership for dealer 2; provide an explicit dealer mapping before continuing';
  END IF;
END $$;

UPDATE whatsapp_conversations
SET dealer_id = 2
WHERE dealer_id IS NULL;

ALTER TABLE whatsapp_conversations
  ALTER COLUMN dealer_id SET NOT NULL,
  ALTER COLUMN dealer_id DROP DEFAULT;

-- Drop the old single-column unique index if present (replaced by composite).
DROP INDEX IF EXISTS whatsapp_conversations_phone_idx;

-- Composite unique: one active session per (dealer, phone).
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_conversations_dealer_phone_idx
  ON whatsapp_conversations (dealer_id, phone);

-- 3. Add dealer-scoped composite index on whatsapp_messages.
CREATE INDEX IF NOT EXISTS whatsapp_messages_dealer_phone_idx
  ON whatsapp_messages (dealer_id, phone);

COMMIT;
