import { readFile } from "node:fs/promises";
if (process.env.NODE_ENV !== "development" || process.env.APPLY_SUPPLIER_INVOICE_MIGRATION !== "yes") {
  throw new Error("Development only: NODE_ENV=development APPLY_SUPPLIER_INVOICE_MIGRATION=yes required");
}
const { pool } = await import("@workspace/db");
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query(await readFile(new URL("../../../../scripts/migrations/2026-09-25-supplier-invoices.sql", import.meta.url), "utf8"));
  await client.query("COMMIT");
} catch (error) { await client.query("ROLLBACK"); throw error; }
finally { client.release(); await pool.end(); }