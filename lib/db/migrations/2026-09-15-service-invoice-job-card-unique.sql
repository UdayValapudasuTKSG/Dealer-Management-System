-- One service invoice per job card, enforced by the database as defense in
-- depth against concurrent issue requests (Task 279 review). Idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS service_invoices_job_card_unique
  ON service_invoices (dealer_id, job_card_id);
