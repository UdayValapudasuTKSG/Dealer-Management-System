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

/** Business divisions within a dealership (CAM Motors / GT Automotive). */
export const DIVISION_CODES = ["CAM", "GT"] as const;
export type DivisionCode = (typeof DIVISION_CODES)[number];

export const divisionsTable = pgTable(
  "divisions",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id")
      .notNull()
      .references(() => dealersTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    code: text("code").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("divisions_dealer_code_idx").on(t.dealerId, t.code)],
);

export const insertDivisionSchema = createInsertSchema(divisionsTable, {
  code: z.enum(DIVISION_CODES),
}).omit({ id: true, createdAt: true });
export type InsertDivision = z.infer<typeof insertDivisionSchema>;
export type Division = typeof divisionsTable.$inferSelect;
