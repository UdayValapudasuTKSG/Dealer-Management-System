import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { financeApplicationsTable } from "./financeApplications";

export const FINANCE_DOC_TYPES = [
  "id_document",
  "payslip",
  "bank_statement",
  "proof_of_address",
  "employment_letter",
  "other",
] as const;
export type FinanceDocType = (typeof FINANCE_DOC_TYPES)[number];

export const financeDocumentsTable = pgTable("finance_documents", {
  id: serial("id").primaryKey(),
  dealerId: integer("dealer_id").notNull(),
  applicationId: integer("application_id")
    .notNull()
    .references(() => financeApplicationsTable.id, { onDelete: "cascade" }),
  type: text("type").notNull().default("other"),
  fileName: text("file_name").notNull(),
  storageKey: text("storage_key").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  uploadedBy: text("uploaded_by"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertFinanceDocumentSchema = createInsertSchema(
  financeDocumentsTable,
  {
    type: z.enum(FINANCE_DOC_TYPES),
  },
).omit({ dealerId: true, id: true, createdAt: true });
export type InsertFinanceDocument = z.infer<
  typeof insertFinanceDocumentSchema
>;
export type FinanceDocument = typeof financeDocumentsTable.$inferSelect;
