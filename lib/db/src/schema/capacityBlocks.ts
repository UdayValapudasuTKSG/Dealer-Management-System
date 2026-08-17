import {
  pgTable,
  serial,
  text,
  integer,
  date,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Capacity planning (test drives): managers block out days when a vehicle or
 * a sales advisor is NOT available for test drives. Absence of a row means
 * available — blocks are the exception, not the rule.
 */
export const CAPACITY_BLOCK_KINDS = ["vehicle", "advisor"] as const;
export type CapacityBlockKind = (typeof CAPACITY_BLOCK_KINDS)[number];

export const capacityBlocksTable = pgTable(
  "capacity_blocks",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    /** "vehicle" (refId = vehicle id) or "advisor" (refId = user id). */
    kind: text("kind").notNull(),
    refId: integer("ref_id").notNull(),
    /** Blocked calendar day (dealer-local), YYYY-MM-DD. */
    date: date("date", { mode: "string" }).notNull(),
    /** Optional hour window (dealer-local, 0-23). Both null = full day. */
    startHour: integer("start_hour"),
    endHour: integer("end_hour"),
    reason: text("reason"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("capacity_blocks_unique").on(t.dealerId, t.kind, t.refId, t.date),
  ],
);

export const insertCapacityBlockSchema = createInsertSchema(
  capacityBlocksTable,
  {
    kind: z.enum(CAPACITY_BLOCK_KINDS),
  },
).omit({ dealerId: true, id: true, createdAt: true });
export type InsertCapacityBlock = z.infer<typeof insertCapacityBlockSchema>;
export type CapacityBlock = typeof capacityBlocksTable.$inferSelect;
