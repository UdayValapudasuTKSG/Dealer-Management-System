-- NC-3 canonical state-machine reconciliation (r1/r2 spec).
-- Idempotent; run once against each environment (already applied to dev).
BEGIN;

-- lead.phase: aware/consider/engage/negotiate -> new/contacted/qualified/negotiation
UPDATE leads SET phase = CASE phase
  WHEN 'aware' THEN 'new'
  WHEN 'consider' THEN 'contacted'
  WHEN 'engage' THEN 'qualified'
  WHEN 'negotiate' THEN 'negotiation'
  ELSE phase END
WHERE phase IN ('aware','consider','engage','negotiate');
UPDATE leads SET phase = 'lost' WHERE status = 'lost' AND phase <> 'lost';

-- deal.stage: fold retired negotiation/finance into desking
UPDATE deals SET stage = 'desking' WHERE stage IN ('negotiation','finance');

-- service_orders.status: RO machine -> Case machine
UPDATE service_orders SET status = CASE status
  WHEN 'scheduled' THEN 'open'
  WHEN 'checked_in' THEN 'acknowledged'
  WHEN 'awaiting_approval' THEN 'on_hold'
  WHEN 'completed' THEN 'resolved'
  WHEN 'delivered' THEN 'closed'
  ELSE status END
WHERE status IN ('scheduled','checked_in','awaiting_approval','completed','delivered');

-- job_cards.status: retire quality_check
UPDATE job_cards SET status = 'completed' WHERE status = 'quality_check';

-- deliveries: 11-step -> canonical 9-step SAGA
UPDATE deliveries SET current_step = CASE current_step
  WHEN 'vehicle_prep' THEN 'pdi_checklist'
  WHEN 'accessory_installation' THEN 'pdi_checklist'
  WHEN 'delivery_appointment' THEN 'appointment'
  WHEN 'vehicle_delivery' THEN 'delivery'
  WHEN 'customer_signature' THEN 'signature'
  ELSE current_step END;
UPDATE deliveries SET steps = (
  SELECT COALESCE(jsonb_agg(
    CASE s->>'key'
      WHEN 'delivery_appointment' THEN s || '{"key":"appointment","label":"Delivery Appointment"}'
      WHEN 'vehicle_delivery' THEN s || '{"key":"delivery","label":"Vehicle Delivery"}'
      WHEN 'customer_signature' THEN s || '{"key":"signature","label":"Customer Signature"}'
      ELSE s END ORDER BY ord), '[]'::jsonb)
  FROM jsonb_array_elements(steps) WITH ORDINALITY AS t(s, ord)
  WHERE s->>'key' NOT IN ('vehicle_prep','accessory_installation')
);

-- cases -> service_cases first-class table (NC-8)
ALTER TABLE IF EXISTS cases RENAME TO service_cases;
ALTER INDEX IF EXISTS cases_dealer_status_idx RENAME TO service_cases_dealer_status_idx;
ALTER INDEX IF EXISTS cases_dealer_customer_idx RENAME TO service_cases_dealer_customer_idx;

-- new column defaults
ALTER TABLE leads ALTER COLUMN phase SET DEFAULT 'new';
ALTER TABLE service_orders ALTER COLUMN status SET DEFAULT 'open';

COMMIT;
