ALTER TABLE part_requisitions
  ALTER COLUMN service_order_id DROP NOT NULL,
  ALTER COLUMN job_card_id DROP NOT NULL;