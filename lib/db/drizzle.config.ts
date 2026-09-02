import { defineConfig } from "drizzle-kit";
import path from "path";

const developmentDatabaseUrl =
  process.env.DATABASE_URL ?? process.env.DEV_DATABASE_URL;

if (!developmentDatabaseUrl) {
  throw new Error(
    "DEV_DATABASE_URL or DATABASE_URL must be set; ensure the development database is provisioned",
  );
}

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  dialect: "postgresql",
  dbCredentials: {
    url: developmentDatabaseUrl,
  },
});
