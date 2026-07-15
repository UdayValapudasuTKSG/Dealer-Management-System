import {
  pgTable,
  serial,
  text,
  integer,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { financeApplicationsTable } from "./financeApplications";

export const losSubmissionsTable = pgTable("los_submissions", {
  id: serial("id").primaryKey(),
  applicationId: integer("application_id")
    .notNull()
    .references(() => financeApplicationsTable.id, { onDelete: "cascade" }),
  connector: text("connector").notNull(),
  mode: text("mode").notNull().default("mock"),
  event: text("event").notNull(),
  status: text("status").notNull(),
  reference: text("reference"),
  message: text("message"),
  payload: jsonb("payload").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertLosSubmissionSchema = createInsertSchema(
  losSubmissionsTable,
  {
    mode: z.enum(["live", "mock"]),
    event: z.enum(["submit", "sync"]),
  },
).omit({ id: true, createdAt: true });
export type InsertLosSubmission = z.infer<typeof insertLosSubmissionSchema>;
export type LosSubmission = typeof losSubmissionsTable.$inferSelect;
