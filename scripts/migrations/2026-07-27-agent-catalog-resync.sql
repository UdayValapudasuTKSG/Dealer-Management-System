-- Agent catalog reconciliation (R3 closed catalog) — 2026-07-27.
-- Replaces the legacy 13-agent roster with the 11 semantic governed agents
-- (must stay in sync with DEFAULT_AGENTS in api-server/src/lib/provisioning.ts)
-- and remaps historical agent_runs keys to the semantic catalog.
-- Idempotent: safe to re-run (dev already applied; run against production
-- with: psql "$DATABASE_URL" -f scripts/migrations/2026-07-27-agent-catalog-resync.sql).

BEGIN;

DELETE FROM agents;
INSERT INTO agents (dealer_id, key, name, domain, description, status)
SELECT d.id, a.key, a.name, a.domain, a.description, a.status
FROM dealers d
CROSS JOIN (VALUES
 ('intake_dedup','Intake & Dedup','Lead Intake','Parses inbound enquiries (email/WhatsApp/web), dedupes against existing leads and creates or merges the lead record.','active'),
 ('call_sentiment','Call Sentiment','Sales Calls','Analyzes call transcripts and notes, writing sentiment and summary onto the call log.','active'),
 ('case_classifier','Case Classifier','Aftersales','Classifies new service cases (type and severity) so they route to the right queue.','active'),
 ('doc_prefill','Document Prefill','Documents','Extracts fields from uploaded customer documents to prefill forms — a human verifies before use.','active'),
 ('outreach','Outreach Drafts','Sales & Pipeline','Drafts customer messages for human Approve & Send — never sends on its own.','active'),
 ('test_drive_availability','Test-Drive Availability','Appointments','Suggests test-drive slots and detects booking intent — a human confirms the booking.','active'),
 ('pipeline_suggestions','Pipeline Suggestions','Sales & Pipeline','Surfaces next-best actions, stage-advance proposals and lead briefs for advisors.','active'),
 ('sentiment_digest','Sentiment Digest','Intelligence','Summarizes customer sentiment across recent interactions for the daily briefing.','active'),
 ('persona_recommend','Persona & Recommendations','Customer Experience','Builds customer personas and recommends vehicles for advisors to present.','active'),
 ('concierge','Concierge','In-App Assistant','In-app navigation and Q&A assistant for staff — never messages customers.','active'),
 ('gra_extract','GRA Extract','Compliance & Import','Transcribes legible fields from import documents for GRA duty filings (server computes the duty).','idle')
) AS a(key,name,domain,description,status);

-- Historical agent_runs key remap (legacy key + run_type → semantic key).
UPDATE agent_runs SET agent_key='doc_prefill' WHERE agent_key='documents';
UPDATE agent_runs SET agent_key='sentiment_digest' WHERE agent_key='analyst';
UPDATE agent_runs SET agent_key='intake_dedup'
 WHERE agent_key IN ('sales','gmail-intake','whatsapp-flow','lead-dedup','intake-orchestration')
   AND run_type IN ('email_intake','whatsapp_intake','lead_dedup','intake_orchestration','enquiry_intake');
UPDATE agent_runs SET agent_key='pipeline_suggestions'
 WHERE agent_key='sales'
   AND run_type IN ('stalled_nudge','advance_proposal','lead_brief','lead_agent_brief','pipeline_suggestions');
UPDATE agent_runs SET agent_key='call_sentiment'
 WHERE agent_key IN ('analyst','call-analysis') OR (agent_key='sales' AND run_type='call_sentiment_auto');
UPDATE agent_runs SET agent_key='test_drive_availability'
 WHERE agent_key IN ('scheduler','test-drive-intent') OR (agent_key='sales' AND run_type='test_drive_intent_auto');
UPDATE agent_runs SET agent_key='quote_tax', autonomy='system'
 WHERE agent_key='sales' AND run_type='quote_generation';
UPDATE agent_runs SET agent_key='auto_desk', autonomy='system'
 WHERE agent_key='sales' AND run_type='auto_desk_deal';
UPDATE agent_runs SET agent_key='vin_allocation', autonomy='system'
 WHERE agent_key='inventory' AND run_type='vin_allocation';

COMMIT;
