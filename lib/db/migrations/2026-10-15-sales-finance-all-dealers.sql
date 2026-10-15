-- Additive only. Do NOT seed here: first upgraded server startup establishes
-- the activation instant before accepting traffic or starting posting workers.
CREATE TABLE IF NOT EXISTS sales_finance_rollout (
  id integer PRIMARY KEY,
  activated_at timestamptz NOT NULL DEFAULT now()
);
