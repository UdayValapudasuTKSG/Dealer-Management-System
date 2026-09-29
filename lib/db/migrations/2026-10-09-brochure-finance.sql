-- Additive development migration. Production schema is managed by Publish.
-- Leave the existing validated 20 MB PDF constraint intact.
BEGIN;
ALTER TABLE dealer_brochures
  ADD COLUMN IF NOT EXISTS finance_model text,
  ADD COLUMN IF NOT EXISTS down_payment_type text,
  ADD COLUMN IF NOT EXISTS down_payment_value numeric(14,2),
  ADD COLUMN IF NOT EXISTS monthly_emi numeric(14,2),
  ADD COLUMN IF NOT EXISTS price_dp numeric(14,2),
  ADD COLUMN IF NOT EXISTS price_df numeric(14,2),
  ADD COLUMN IF NOT EXISTS finance_customized boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'dealer_brochures'::regclass
      AND conname = 'dealer_brochures_down_payment_check'
  ) THEN
    ALTER TABLE dealer_brochures
      ADD CONSTRAINT dealer_brochures_down_payment_check
      CHECK (
        (down_payment_type IS NULL AND down_payment_value IS NULL)
        OR (down_payment_type IN ('amount', 'percent')
          AND down_payment_value >= 0
          AND (down_payment_type <> 'percent' OR down_payment_value <= 100))
      );
  END IF;
END $$;

-- GT Automotive's six existing, content-addressed PDFs only. Verify the
-- original digest AND owning dealer before seeding; never re-price a replaced
-- brochure, a custom brochure, or any other dealership's library. All fields
-- must still be blank and not explicitly customized, so reruns preserve edits.
UPDATE dealer_brochures AS b
SET finance_model = offer.model,
    down_payment_type = offer.kind,
    down_payment_value = offer.down_value,
    monthly_emi = offer.emi,
    price_dp = offer.dp,
    price_df = offer.df
FROM dealers AS d,
  (VALUES
    ('dolphin-mini', '26e21a35c479d2023309e6809d52b6c276b39ac224c4401889b72ea3778e97b3', 'Mini', 'amount', 150000, 49900, 4500000, NULL::numeric),
    ('song-pro', 'a8dafabff723049e98c6f36b4454c5716e39e64157f1c89dc498d9bf9e4a311e', 'Pro', 'amount', 300000, 69900, 5699000, NULL::numeric),
    ('yuan-plus', 'b0fe02279391ff916fafb380c4025a8ab5bf76f01ff8d0ff61a6c83c24d060ed', 'Yuan Plus', 'percent', 10, 95500, 7500000, NULL::numeric),
    ('song-plus-dmi', 'c2ca09a9f609d45e1616fcbf1ef7885318c646208b4944f4375c2dd2e6df8098', 'Song Plus', 'percent', 10, 122141, 9600000, 7600000),
    ('shark', 'bd58361d6d4f5fa935a8f9c59a35681c8057a08b993d9cfbef1c6e44fe3ce3a6', 'Shark', 'amount', 625000, 154900, 12500000, 10500000),
    ('atto-8', '862ba9fc6b2908ceb85213c5bcc8dcf455ed7b128cd9a220130dcac2b886d3cd', 'Atto 8', 'percent', 10, 177920, 14500000, NULL::numeric)
  ) AS offer(id, original_sha, model, kind, down_value, emi, dp, df)
WHERE b.id = offer.id AND b.sha = offer.original_sha
  AND b.dealer_id = d.id AND d.id = 1 AND d.name = 'GT Automotive'
  AND NOT b.finance_customized
  AND b.finance_model IS NULL AND b.down_payment_type IS NULL
  AND b.down_payment_value IS NULL AND b.monthly_emi IS NULL
  AND b.price_dp IS NULL AND b.price_df IS NULL;
COMMIT;