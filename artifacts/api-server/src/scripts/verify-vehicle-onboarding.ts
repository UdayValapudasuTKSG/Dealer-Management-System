/**
 * Development-only, read-only verification of onboarding schema/security
 * invariants. It never creates an invitation and therefore never sends email.
 */
import { pool } from "@workspace/db";

if (process.env.NODE_ENV === "production") {
  throw new Error("verify-vehicle-onboarding is development-only");
}

const required = new Map([
  ["garage_vehicles", ["dealer_id", "customer_id", "registration"]],
  ["vehicle_onboarding_requests", ["dealer_id", "customer_id", "service_order_id", "token_hash", "expires_at", "submitted_at"]],
  ["vehicle_onboarding_media", ["request_id", "dealer_id", "customer_id", "object_path", "mime_type", "size_bytes"]],
]);

for (const [table, columns] of required) {
  const result = await pool.query<{ column_name: string }>(
    `select column_name from information_schema.columns where table_schema = 'public' and table_name = $1`,
    [table],
  );
  const actual = new Set(result.rows.map((row) => row.column_name));
  for (const column of columns) {
    if (!actual.has(column)) throw new Error(`${table}.${column} is missing`);
  }
}

const indexes = await pool.query<{ indexdef: string }>(
  `select indexdef from pg_indexes where schemaname = 'public' and
   tablename in ('garage_vehicles', 'vehicle_onboarding_requests', 'vehicle_onboarding_media')`,
);
const definitions = indexes.rows.map((row) => row.indexdef).join("\n");
for (const marker of ["token_hash", "dealer_id, customer_id, registration", "object_path"]) {
  if (!definitions.includes(marker)) throw new Error(`Required unique index is missing: ${marker}`);
}

console.log("vehicle onboarding schema/security invariants verified (read-only; no email sent)");
await pool.end();