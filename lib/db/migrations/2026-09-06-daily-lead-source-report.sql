-- Task 269: dealership-level toggle for the daily lead-source report email.
-- Sent to General Managers around 6:00 AM dealership-local time. Default OFF.
BEGIN;

ALTER TABLE dealer_service_settings
  ADD COLUMN IF NOT EXISTS lead_source_report_enabled boolean NOT NULL DEFAULT false;

COMMIT;
