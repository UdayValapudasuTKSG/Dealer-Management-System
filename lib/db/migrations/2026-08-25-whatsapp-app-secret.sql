-- Per-channel Meta app secret (encrypted) for webhook signature verification.
-- Additive & idempotent.
ALTER TABLE whatsapp_channels
  ADD COLUMN IF NOT EXISTS app_secret_ciphertext text;
