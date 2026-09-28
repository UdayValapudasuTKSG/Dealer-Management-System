import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";

const url = process.env.DATABASE_URL ?? process.env.DEV_DATABASE_URL;
if (process.env.NODE_ENV === "production" || !url ||
    !["helium", "localhost", "127.0.0.1"].includes(new URL(url).hostname.toLowerCase()) ||
    (process.env.EXTERNAL_DATABASE_URL && url === process.env.EXTERNAL_DATABASE_URL)) {
  throw new Error("Refusing brochure size verification: development database URL required.");
}

const client = await pool.connect();
try {
  await client.query("BEGIN");
  const dealer = await client.query<{ id: number }>("SELECT id FROM dealers LIMIT 1");
  if (!dealer.rows[0]) throw new Error("No dealer available for brochure verification.");
  for (const [size, expected] of [
    [20971521, true], [88317429, true], [104857600, true], [104857601, false],
  ] as const) {
    await client.query("SAVEPOINT brochure_size_probe");
    let accepted = false;
    try {
      await client.query(
        `INSERT INTO dealer_brochures (id, dealer_id, title, file_name, object_path, sha, size_bytes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [randomUUID(), dealer.rows[0].id, "Size check", "size-check.pdf",
          `/objects/brochure-size-check/${randomUUID()}`, "size-check", size],
      );
      accepted = true;
    } catch (error) {
      if ((error as { code?: string }).code !== "23514") throw error;
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT brochure_size_probe");
      await client.query("RELEASE SAVEPOINT brochure_size_probe");
    }
    if (accepted !== expected) throw new Error(`Brochure size ${size}: expected ${expected ? "accepted" : "rejected"}.`);
    console.log(`Development insert ${size} bytes: ${accepted ? "accepted" : "rejected (CHECK)"}`);
  }
} finally {
  await client.query("ROLLBACK");
  client.release();
  await pool.end();
}