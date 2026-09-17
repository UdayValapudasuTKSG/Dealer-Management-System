-- Gmail service booking intake provenance.  Additive and nullable so the
-- existing sales/webhook ledger remains valid and old rows need no backfill.
ALTER TABLE webhook_events
  ADD COLUMN IF NOT EXISTS service_order_id integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'webhook_events_service_order_id_fkey'
  ) THEN
    ALTER TABLE webhook_events
      ADD CONSTRAINT webhook_events_service_order_id_fkey
      FOREIGN KEY (service_order_id) REFERENCES service_orders(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS webhook_events_service_order_idx
  ON webhook_events (service_order_id)
  WHERE service_order_id IS NOT NULL;