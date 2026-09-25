import { readFile } from "node:fs/promises";
import { pool } from "@workspace/db";

if (process.env.NODE_ENV !== "development" || process.env.APPLY_PO_IMPORT_MIGRATION !== "1" || process.env.EXTERNAL_DATABASE_URL) {
  throw new Error("Development-only migration: set NODE_ENV=development APPLY_PO_IMPORT_MIGRATION=1; external production connections are prohibited");
}
try {
  await pool.query(await readFile(new URL("../../../../lib/db/migrations/2026-09-25-purchase-order-import.sql", import.meta.url), "utf8"));
  console.log("Purchase-order import migration applied.");
} finally { await pool.end(); }