import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { dealersTable } from "./dealers";

/**
 * Divisions are business units within a dealer group (per DMS spec: CAM
 * Motors and GT Automotive). Records that matter carry `divisionId` alongside
 * `dealerId` so leadership reporting can slice across divisions.
 */
export const divisionsTable = pgTable(
  "divisions",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id")
      .notNull()
      .references(() => dealersTable.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("divisions_dealer_code_idx").on(t.dealerId, t.code)],
);

export const insertDivisionSchema = createInsertSchema(divisionsTable, {
  code: z.string().min(1).max(8),
  name: z.string().min(1),
}).omit({ id: true, createdAt: true });
export type InsertDivision = z.infer<typeof insertDivisionSchema>;
export type Division = typeof divisionsTable.$inferSelect;
