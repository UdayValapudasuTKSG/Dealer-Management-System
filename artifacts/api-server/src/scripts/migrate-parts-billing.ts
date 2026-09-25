import { readFile } from "node:fs/promises";

if (process.env.NODE_ENV !== "development" || process.env.APPLY_PARTS_BILLING_MIGRATION !== "1" || process.env.EXTERNAL_DATABASE_URL) {
  throw new Error("Development-only migration: NODE_ENV=development APPLY_PARTS_BILLING_MIGRATION=1 required; external connections prohibited.");
}
const { pool } = await import("@workspace/db");
try {
  await pool.query(await readFile(new URL("../../../../lib/db/migrations/2026-09-27-parts-customer-billing.sql", import.meta.url), "utf8"));
  console.log("Parts billing additive migration applied.");
} finally { await pool.end(); }