/**
 * Non-destructive migration/invariant smoke verification.
 * It never imports the outbox worker and all assertions are read-only SQL.
 * Run only after applying the migration to an explicitly opted-in dev/test DB.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const url = process.env.DATABASE_URL ?? "";
const permitted =
  process.env.VERIFY_SERVICE_LIFECYCLE_DB === "1" &&
  ["development", "test"].includes(process.env.NODE_ENV ?? "") &&
  /(localhost|127\.0\.0\.1|helium|\.test\b|\.dev\b)/i.test(url) &&
  (!process.env.PROD_DATABASE_URL || url !== process.env.PROD_DATABASE_URL) &&
  !/(production|prod\b)/i.test(url);
if (!permitted) {
  throw new Error(
    "Refusing database verification: opt in explicitly and use the allowlisted development database.",
  );
}

const required = [
  ["service_estimate_decisions", "invalidated_at"],
  ["feedback_invitations", "service_order_id"],
  ["feedback_invitations", "customer_id"],
  ["feedback_invitations", "token_hash"],
] as const;
for (const [table, column] of required) {
  const result = await db.execute(sql`
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = ${table} and column_name = ${column}
  `);
  if (!result.rows.length) throw new Error(`Missing ${table}.${column}; apply the lifecycle migration.`);
}

const indexes = await db.execute(sql`
  select indexname from pg_indexes
  where schemaname = 'public'
    and indexname in (
      'service_estimate_decisions_token_hash_uq',
      'service_estimate_decisions_entity_idx',
      'feedback_invitations_token_hash_uq',
      'feedback_invitations_service_order_uq'
    )
`);
if (indexes.rows.length !== 4) {
  throw new Error("Missing lifecycle uniqueness or entity indexes.");
}
console.log("Service lifecycle schema verification passed (read-only; no outbox worker imported).");