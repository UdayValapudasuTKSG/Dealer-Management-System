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
const migrationFiles = [
  "../migrations/2026-09-28-dealer-brochures.sql",
  "../migrations/2026-09-28-dealer-brochures-100mb.sql",
  "../migrations/2026-09-29-dealer-brochures-20mb.sql",
];
const client = await pool.connect();
try {
  await client.query("BEGIN");
  for (const file of migrationFiles) {
    const sql = await readFile(fileURLToPath(new URL(file, import.meta.url)), "utf8");
    await client.query(sql);
  }
  await client.query("COMMIT");
  console.log("Development dealer brochure migrations applied.");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}