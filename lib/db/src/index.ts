import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

// Production runs against the customer's own hosted Postgres when
// EXTERNAL_DATABASE_URL is set; development always uses the built-in
// Replit database (DATABASE_URL).
const connectionString =
  process.env.NODE_ENV === "production" && process.env.EXTERNAL_DATABASE_URL
    ? process.env.EXTERNAL_DATABASE_URL
    : process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString });
export const db = drizzle(pool, { schema });

export * from "./schema";
