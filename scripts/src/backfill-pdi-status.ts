/**
 * One-time backfill: converts legacy delivery pdi_items entries shaped
 * `{ label, checked }` to the tri-state `{ label, status }` shape introduced
 * by the L7/L8 delivery reconciliation. Safe to re-run (idempotent) and safe
 * on empty databases. Run against production with the prod DATABASE_URL.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  const result = await db.execute(sql`
    UPDATE deliveries
    SET pdi_items = (
      SELECT COALESCE(
        jsonb_agg(
          CASE
            WHEN item ? 'status' THEN item
            ELSE jsonb_build_object(
              'label', COALESCE(item->>'label', 'PDI item'),
              'status', CASE WHEN (item->>'checked')::boolean IS TRUE THEN 'pass' ELSE 'pending' END
            )
          END
        ),
        '[]'::jsonb
      )
      FROM jsonb_array_elements(pdi_items) AS item
    )
    WHERE jsonb_typeof(pdi_items) = 'array'
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(pdi_items) AS i
        WHERE NOT (i ? 'status')
      )
  `);
  console.log(`backfill-pdi-status: updated ${result.rowCount ?? 0} delivery row(s)`);
  process.exit(0);
}

main().catch((err) => {
  console.error("backfill-pdi-status failed:", err);
  process.exit(1);
});
