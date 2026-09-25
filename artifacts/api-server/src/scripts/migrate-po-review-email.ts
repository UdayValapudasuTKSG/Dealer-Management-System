import { readFile } from "node:fs/promises";
if (process.env.NODE_ENV !== "development" || process.env.APPLY_PO_REVIEW_MIGRATION !== "1" || process.env.EXTERNAL_DATABASE_URL) {
  throw new Error("Development-only migration: set NODE_ENV=development APPLY_PO_REVIEW_MIGRATION=1; external production connections are prohibited");
}
const target = new URL(process.env.DATABASE_URL ?? process.env.DEV_DATABASE_URL ?? "");
if (!["helium", "localhost", "127.0.0.1"].includes(target.hostname)) throw new Error("Database host is not development allowlisted");
const { pool } = await import("@workspace/db");
try {
  await pool.query(await readFile(new URL("../../../../lib/db/migrations/2026-10-05-po-review-email.sql", import.meta.url), "utf8"));
  console.log("PO review/email migration applied.");
} finally { await pool.end(); }