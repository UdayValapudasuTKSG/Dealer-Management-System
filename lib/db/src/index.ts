import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

// Production may intentionally override the managed database. Development
// prefers Replit's runtime-managed DATABASE_URL; DEV_DATABASE_URL is retained
// only as a compatibility fallback for environments without that binding.
const connectionString =
  process.env.NODE_ENV === "production"
    ? process.env.EXTERNAL_DATABASE_URL ?? process.env.DATABASE_URL
    : process.env.DATABASE_URL ?? process.env.DEV_DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "DEV_DATABASE_URL or DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString });

// A dropped idle connection (hosted Postgres terminates idle sockets) emits
// an 'error' on the pool; without a listener Node treats it as an uncaught
// exception and kills the whole process — taking down in-flight work (e.g.
// a lead created but not yet assigned). Log and let the pool replace the
// connection instead.
pool.on("error", (err) => {
  console.error("[db] idle client error (connection will be replaced):", err.message);
});
export const db = drizzle(pool, { schema });

export * from "./schema";
