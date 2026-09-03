ALTER TABLE parts
  ADD COLUMN IF NOT EXISTS low_stock_alert_active boolean NOT NULL DEFAULT false;

ALTER TABLE parts
  ADD COLUMN IF NOT EXISTS low_stock_alert_cycle integer NOT NULL DEFAULT 0;