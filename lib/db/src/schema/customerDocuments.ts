import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { customersTable } from "./customers";

export const customerDocumentsTable = pgTable("customer_documents", {
  id: serial("id").primaryKey(),
  dealerId: integer("dealer_id").notNull(),
  customerId: integer("customer_id")
    .notNull()
    .references(() => customersTable.id, { onDelete: "cascade" }),
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

export const insertCustomerDocumentSchema = createInsertSchema(
  customerDocumentsTable,
  {
    type: z.enum(["driver_license", "passport", "tax_document", "other"]),
  },
).omit({ dealerId: true, id: true, createdAt: true });
export type InsertCustomerDocument = z.infer<
  typeof insertCustomerDocumentSchema
>;
export type CustomerDocument = typeof customerDocumentsTable.$inferSelect;
