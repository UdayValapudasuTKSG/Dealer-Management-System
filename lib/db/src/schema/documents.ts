import {
  pgTable,
  serial,
  text,
  integer,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const DOCUMENT_ENTITY_TYPES = ["lead", "vehicle"] as const;
export type DocumentEntityType = (typeof DOCUMENT_ENTITY_TYPES)[number];

export const DOCUMENT_TYPES = [
  "id_document",
  "financing",
  "test_drive",
  "insurance",
  "registration",
  "customs",
  "invoice",
  "quote",
  "other",
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const DOCUMENT_EXTRACTION_STATUSES = [
  "none",
  "pending",
  "proposed",
  "accepted",
  "dismissed",
  "failed",
] as const;
export type DocumentExtractionStatus =
  (typeof DOCUMENT_EXTRACTION_STATUSES)[number];

export type DocumentExtractionField = {
  field: string;
  label: string;
  value: string;
};

export type DocumentExtractionData = {
  summary: string | null;
  fields: DocumentExtractionField[];
};

export const documentsTable = pgTable(
  "documents",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: integer("entity_id").notNull(),
    type: text("type").notNull().default("other"),
    version: integer("version").notNull().default(1),
    fileName: text("file_name").notNull(),
    // Object-storage path (/objects/...). Null only for legacy migrated links.
    storageKey: text("storage_key"),
    // Legacy pasted-link attachments migrated from leads.attachments.
    externalUrl: text("external_url"),
    mimeType: text("mime_type").notNull().default("application/octet-stream"),
    sizeBytes: integer("size_bytes").notNull().default(0),
    comments: text("comments"),
    uploadedBy: text("uploaded_by"),
    extractionStatus: text("extraction_status").notNull().default("none"),
    extraction: jsonb("extraction").$type<DocumentExtractionData>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("documents_entity_idx").on(t.entityType, t.entityId)],
);

export const insertDocumentSchema = createInsertSchema(documentsTable, {
  entityType: z.enum(DOCUMENT_ENTITY_TYPES),
  type: z.enum(DOCUMENT_TYPES),
}).omit({ dealerId: true, id: true, createdAt: true });
export type InsertDocument = z.infer<typeof insertDocumentSchema>;
export type DealerDocument = typeof documentsTable.$inferSelect;
