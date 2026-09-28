import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { pool } from "@workspace/db";

// Explicit development-only migration: never target an external/production URL.
const url = process.env.DATABASE_URL ?? process.env.DEV_DATABASE_URL;
if (process.env.NODE_ENV === "production" || !url ||
    !["helium", "localhost", "127.0.0.1"].includes(new URL(url).hostname.toLowerCase()) ||
    (process.env.EXTERNAL_DATABASE_URL && url === process.env.EXTERNAL_DATABASE_URL)) {
  throw new Error("Refusing brochure migration: development database URL required.");
}
const path = fileURLToPath(new URL("../migrations/2026-09-28-dealer-brochures.sql", import.meta.url));
const sql = await readFile(path, "utf8");
try {
  await pool.query(sql);
  console.log("Development dealer brochure migration applied.");
} finally {
  await pool.end();
}