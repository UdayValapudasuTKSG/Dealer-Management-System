CREATE TABLE IF NOT EXISTS purchase_order_receipt_lines (
  id serial PRIMARY KEY,
  dealer_id integer NOT NULL,
  receipt_id integer NOT NULL REFERENCES purchase_order_receipts(id) ON DELETE CASCADE,
  purchase_order_line_id integer NOT NULL REFERENCES purchase_order_lines(id),
  quantity integer NOT NULL CHECK (quantity > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS purchase_order_receipt_lines_receipt_line_unique
  ON purchase_order_receipt_lines(receipt_id, purchase_order_line_id);

CREATE INDEX IF NOT EXISTS purchase_order_receipt_lines_dealer_receipt_idx
  ON purchase_order_receipt_lines(dealer_id, receipt_id);

INSERT INTO purchase_order_receipt_lines (
  dealer_id,
  receipt_id,
  purchase_order_line_id,
  quantity
)
SELECT
  receipt.dealer_id,
  receipt.id,
  (line.value ->> 0)::integer,
  (line.value ->> 1)::integer
FROM purchase_order_receipts receipt
CROSS JOIN LATERAL jsonb_array_elements(
  CASE
    WHEN jsonb_typeof(receipt.request_fingerprint::jsonb) = 'array'
      THEN receipt.request_fingerprint::jsonb
    ELSE COALESCE(receipt.request_fingerprint::jsonb -> 'lines', '[]'::jsonb)
  END
) AS line(value)
ON CONFLICT (receipt_id, purchase_order_line_id) DO NOTHING;