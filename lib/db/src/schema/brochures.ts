import { pgTable, text, integer, boolean, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { dealersTable } from "./dealers";

export const brochuresTable = pgTable("dealer_brochures", {
  id: text("id").primaryKey(),
  dealerId: integer("dealer_id").notNull().references(() => dealersTable.id),
  title: text("title").notNull(),
  fileName: text("file_name").notNull(),
  objectPath: text("object_path").notNull(),
  sha: text("sha").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("dealer_brochures_object_path_idx").on(t.objectPath)]);