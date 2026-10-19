/**
 * Explicitly authorised fixture data only. Never runs migrations or starts
 * background workers, never creates ERP documents or customer communications.
 */
export {};
const production = process.argv.includes("--production-dummy");
if (production) {
  if (!process.env.PROD_DATABASE_URL) throw new Error("Production connection is not configured");
  process.env.DATABASE_URL = process.env.PROD_DATABASE_URL;
  process.env.NODE_ENV = "development"; // DB module reads the explicitly selected DATABASE_URL.
} else {
  const raw = process.env.DATABASE_URL ?? process.env.DEV_DATABASE_URL;
  if (!raw || !["helium", "localhost", "127.0.0.1"].includes(new URL(raw).hostname))
    throw new Error("Development database is not allowlisted");
}
process.env.OUTBOX_WORKER_DISABLED = "1";
const { db, pool } = await import("@workspace/db");
const { seedPosParts, posLock } = await import("../lib/parts-pos");
try {
  const parts = await db.transaction(async tx => {
    await posLock(tx, 2);
    // seedPosParts checks the exact dealer ID AND name before any mutation.
    return seedPosParts(tx, 2);
  });
  console.log(JSON.stringify({ environment: production ? "production" : "development", dealership: "CAM Motors Dummy", parts }));
} finally { await pool.end(); }
