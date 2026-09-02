-- Guided collision workflow. Idempotent so development and deployed databases
-- can safely apply the tracked migration independently.
CREATE TABLE IF NOT EXISTS collision_checklist_items (
  id serial PRIMARY KEY,
  dealer_id integer NOT NULL,
  claim_id integer NOT NULL REFERENCES collision_claims(id) ON DELETE CASCADE,
  category text NOT NULL, key text NOT NULL, label text NOT NULL,
  description text NOT NULL, audience text NOT NULL,
  required_for_status text, status text NOT NULL DEFAULT 'missing',
  document_id integer REFERENCES documents(id) ON DELETE SET NULL,
  requested_by_user_id integer, requested_by_name text, requested_at timestamptz,
  verified_by_user_id integer, verified_by_name text, verified_at timestamptz,
  waived_by_user_id integer, waived_by_name text, waived_at timestamptz,
  waiver_reason text, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT collision_checklist_audience_check CHECK (audience IN ('customer','insurer','workshop')),
  CONSTRAINT collision_checklist_status_check CHECK (status IN ('missing','requested','uploaded','verified','waived')),
  CONSTRAINT collision_checklist_waiver_check CHECK (
    (status <> 'waived') OR (waived_at IS NOT NULL AND length(trim(waiver_reason)) > 0)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS collision_checklist_claim_key_unique
  ON collision_checklist_items(claim_id, key);
CREATE INDEX IF NOT EXISTS collision_checklist_dealer_claim_idx
  ON collision_checklist_items(dealer_id, claim_id);
CREATE INDEX IF NOT EXISTS collision_checklist_gate_idx
  ON collision_checklist_items(dealer_id, claim_id, required_for_status);

CREATE TABLE IF NOT EXISTS collision_claim_communications (
  id serial PRIMARY KEY, dealer_id integer NOT NULL,
  claim_id integer NOT NULL REFERENCES collision_claims(id) ON DELETE CASCADE,
  audience text NOT NULL, kind text NOT NULL, recipient text NOT NULL,
  subject text NOT NULL, body text NOT NULL, status text NOT NULL DEFAULT 'draft',
  generated_by_agent boolean NOT NULL DEFAULT false, model text, prompt_version text,
  created_by_user_id integer, created_by_name text NOT NULL,
  edited_by_user_id integer, edited_by_name text, edited_at timestamptz,
  sent_by_user_id integer, sent_by_name text, sent_at timestamptz,
  outbox_id integer, error_code text, generation_idempotency_key text,
  send_idempotency_key text, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT collision_communication_audience_check CHECK (audience IN ('customer','insurer')),
  CONSTRAINT collision_communication_status_check CHECK (status IN ('draft','queued','sent','failed','cancelled'))
);
CREATE INDEX IF NOT EXISTS collision_comms_dealer_claim_idx
  ON collision_claim_communications(dealer_id, claim_id);
CREATE UNIQUE INDEX IF NOT EXISTS collision_comms_generation_idempotency_unique
  ON collision_claim_communications(dealer_id, claim_id, generation_idempotency_key)
  WHERE generation_idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS collision_comms_send_idempotency_unique
  ON collision_claim_communications(dealer_id, claim_id, send_idempotency_key)
  WHERE send_idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS collision_portal_invitations (
  id serial PRIMARY KEY, dealer_id integer NOT NULL,
  claim_id integer NOT NULL REFERENCES collision_claims(id) ON DELETE CASCADE,
  customer_id integer, email text NOT NULL, token_hash text NOT NULL,
  expires_at timestamptz NOT NULL, revoked_at timestamptz, last_accessed_at timestamptz,
  idempotency_key text NOT NULL, created_by_user_id integer, created_by_name text NOT NULL,
  revoked_by_user_id integer, revoked_by_name text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS collision_portal_token_hash_unique
  ON collision_portal_invitations(token_hash);
CREATE UNIQUE INDEX IF NOT EXISTS collision_portal_invite_idempotency_unique
  ON collision_portal_invitations(dealer_id, claim_id, idempotency_key);
CREATE INDEX IF NOT EXISTS collision_portal_dealer_claim_idx
  ON collision_portal_invitations(dealer_id, claim_id);
CREATE TABLE IF NOT EXISTS collision_portal_uploads (
  id serial PRIMARY KEY, dealer_id integer NOT NULL,
  invitation_id integer NOT NULL REFERENCES collision_portal_invitations(id) ON DELETE CASCADE,
  claim_id integer NOT NULL REFERENCES collision_claims(id) ON DELETE CASCADE,
  checklist_item_id integer NOT NULL REFERENCES collision_checklist_items(id) ON DELETE CASCADE,
  object_path text NOT NULL, mime_type text NOT NULL, file_name text NOT NULL,
  finalized_at timestamptz, document_id integer REFERENCES documents(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS collision_portal_uploads_invite_idx ON collision_portal_uploads(invitation_id);
CREATE INDEX IF NOT EXISTS collision_portal_uploads_item_idx ON collision_portal_uploads(dealer_id, checklist_item_id);

ALTER TABLE part_requisitions ADD COLUMN IF NOT EXISTS collision_claim_id integer;
DO $$ BEGIN
  ALTER TABLE part_requisitions
    ADD CONSTRAINT part_requisitions_collision_claim_fk
    FOREIGN KEY (collision_claim_id) REFERENCES collision_claims(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS part_requisitions_dealer_collision_claim_idx
  ON part_requisitions(dealer_id, collision_claim_id);