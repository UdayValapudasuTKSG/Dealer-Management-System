BEGIN;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS call_centre_status text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS call_centre_rep_id integer;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS call_centre_assigned_at timestamptz;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS call_centre_transferred_at timestamptz;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS call_centre_follow_up_date date;
CREATE INDEX IF NOT EXISTS leads_call_centre_queue_idx ON leads (dealer_id, call_centre_status, call_centre_rep_id) WHERE deleted_at IS NULL;
COMMIT;