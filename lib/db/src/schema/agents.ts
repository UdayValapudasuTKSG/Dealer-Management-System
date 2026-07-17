import {
  pgTable,
  serial,
  text,
  integer,
  doublePrecision,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const agentsTable = pgTable("agents", {
  id: serial("id").primaryKey(),
  dealerId: integer("dealer_id").notNull(),
  key: text("key").notNull(),
  name: text("name").notNull(),
  domain: text("domain").notNull(),
  description: text("description").notNull(),
  status: text("status").notNull().default("active"),
  tasksToday: integer("tasks_today").notNull().default(0),
  successRate: doublePrecision("success_rate").notNull().default(0),
});

export const insertAgentSchema = createInsertSchema(agentsTable).omit({ dealerId: true,
  id: true,
});
export type InsertAgent = z.infer<typeof insertAgentSchema>;
export type Agent = typeof agentsTable.$inferSelect;
