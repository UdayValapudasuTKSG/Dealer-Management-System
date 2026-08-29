-- Task 271: configurable dealership-local send time for the daily
-- lead-source report email. 24h "HH:MM" string, default 06:00.
BEGIN;

ALTER TABLE dealer_service_settings
  ADD COLUMN IF NOT EXISTS lead_source_report_send_time text NOT NULL DEFAULT '06:00';

COMMIT;
