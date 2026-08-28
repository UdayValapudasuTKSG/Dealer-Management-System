-- Custom lead feedback forms (task: GM form builder + pipeline bulk send).
-- Additive and idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS feedback_forms (
  id SERIAL PRIMARY KEY,
  dealer_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  questions JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS feedback_forms_dealer_idx
  ON feedback_forms (dealer_id, status);

CREATE TABLE IF NOT EXISTS feedback_invitations (
  id SERIAL PRIMARY KEY,
  dealer_id INTEGER NOT NULL,
  form_id INTEGER NOT NULL,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  form_name TEXT NOT NULL,
  questions_snapshot JSONB NOT NULL,
  token TEXT NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'sent',
  channels JSONB NOT NULL DEFAULT '[]'::jsonb,
  email_log_id INTEGER,
  whatsapp_log_id INTEGER,
  answers JSONB,
  submitted_at TIMESTAMPTZ,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS feedback_invitations_form_lead_uq
  ON feedback_invitations (dealer_id, form_id, lead_id);
CREATE INDEX IF NOT EXISTS feedback_invitations_lead_idx
  ON feedback_invitations (dealer_id, lead_id);
CREATE INDEX IF NOT EXISTS feedback_invitations_form_idx
  ON feedback_invitations (dealer_id, form_id);
