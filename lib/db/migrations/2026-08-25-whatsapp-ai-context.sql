-- Conversational WhatsApp agent: durable structured memory per conversation.
-- Additive + idempotent.
ALTER TABLE whatsapp_conversations ADD COLUMN IF NOT EXISTS ai_context text;
