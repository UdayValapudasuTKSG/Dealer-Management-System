/**
 * One-time (re-runnable, idempotent) backfill: resolve assignment display
 * names to user IDs so briefing scoping can match by ID instead of name.
 *
 * - deals.sales_advisor        -> deals.sales_advisor_user_id
 * - service_orders.technician  -> service_orders.technician_user_id
 * - leads.assigned_to          -> leads.owner_user_id
 *
 * A name only backfills when it matches exactly ONE user within the record's
 * dealer (case-insensitive). Ambiguous or unknown names (e.g. AI agents like
 * "Concierge") are left NULL — the UI's name fallback still covers them.
 *
 * Run: pnpm --filter @workspace/scripts run backfill-assignee-user-ids
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function backfill(
  label: string,
  table: string,
  nameCol: string,
  idCol: string,
): Promise<void> {
  const result = await db.execute(sql`
    WITH matches AS (
      SELECT t.id AS record_id, min(u.id) AS uid, count(DISTINCT u.id) AS n
      FROM ${sql.raw(table)} t
      JOIN dealer_users du ON du.dealer_id = t.dealer_id
      JOIN users u
        ON u.id = du.user_id
       AND lower(u.name) = lower(trim(t.${sql.raw(nameCol)}))
      WHERE t.${sql.raw(idCol)} IS NULL
        AND t.${sql.raw(nameCol)} IS NOT NULL
      GROUP BY t.id
    )
    UPDATE ${sql.raw(table)} AS t
    SET ${sql.raw(idCol)} = m.uid
    FROM matches m
    WHERE t.id = m.record_id AND m.n = 1
  `);
  console.log(`${label}: backfilled ${result.rowCount ?? 0} record(s)`);
}

async function main(): Promise<void> {
  await backfill("deals", "deals", "sales_advisor", "sales_advisor_user_id");
  await backfill(
    "service orders",
    "service_orders",
    "technician",
    "technician_user_id",
  );
  await backfill("leads", "leads", "assigned_to", "owner_user_id");
  process.exit(0);
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
