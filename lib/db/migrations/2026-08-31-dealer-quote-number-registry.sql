-- A quote number is dealer-wide identity owned by one lead; revisions for that
-- lead intentionally continue sharing it.
-- First deterministically rename only colliding lead groups, preserving every
-- group's versions/status/history.
WITH group_rank AS (
  SELECT dealer_id, lead_id, quote_number,
         dense_rank() OVER (
           PARTITION BY dealer_id, quote_number
           ORDER BY lead_id
         ) AS owner_rank
  FROM quotes
  GROUP BY dealer_id, lead_id, quote_number
),
collisions AS (
  SELECT dealer_id, lead_id, quote_number,
         row_number() OVER (PARTITION BY dealer_id ORDER BY quote_number, lead_id) AS offset_no
  FROM group_rank
  WHERE owner_rank > 1
),
dealer_max AS (
  SELECT dealer_id,
         coalesce(max((substring(quote_number from '[0-9]+$'))::integer), 0) AS max_no
  FROM quotes
  GROUP BY dealer_id
),
renames AS (
  SELECT c.dealer_id, c.lead_id, c.quote_number AS old_number,
         'EST-' || lpad((m.max_no + c.offset_no)::text, 5, '0') AS new_number
  FROM collisions c
  JOIN dealer_max m USING (dealer_id)
)
UPDATE quotes q
SET quote_number = r.new_number
FROM renames r
WHERE q.dealer_id = r.dealer_id
  AND q.lead_id = r.lead_id
  AND q.quote_number = r.old_number;

CREATE TABLE IF NOT EXISTS quote_numbers (
  dealer_id integer NOT NULL,
  quote_number text NOT NULL,
  lead_id integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS quote_numbers_dealer_number_uq
  ON quote_numbers (dealer_id, quote_number);
CREATE UNIQUE INDEX IF NOT EXISTS quote_numbers_dealer_lead_uq
  ON quote_numbers (dealer_id, lead_id);
CREATE UNIQUE INDEX IF NOT EXISTS quote_numbers_owner_tuple_uq
  ON quote_numbers (dealer_id, quote_number, lead_id);

INSERT INTO quote_numbers (dealer_id, quote_number, lead_id)
SELECT dealer_id, quote_number, lead_id
FROM quotes
GROUP BY dealer_id, quote_number, lead_id
ON CONFLICT DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'quotes_quote_number_owner_fk'
  ) THEN
    ALTER TABLE quotes
      ADD CONSTRAINT quotes_quote_number_owner_fk
      FOREIGN KEY (dealer_id, quote_number, lead_id)
      REFERENCES quote_numbers (dealer_id, quote_number, lead_id)
      NOT VALID;
  END IF;
END $$;