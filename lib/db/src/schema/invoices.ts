import {
  pgTable,
  serial,
  text,
  integer,
  doublePrecision,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const INVOICE_STATUSES = [
  "issued",
  "partially_paid",
  "paid",
  "void",
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const invoicesTable = pgTable("invoices", {
  id: serial("id").primaryKey(),
  dealerId: integer("dealer_id").notNull(),
  invoiceNumber: text("invoice_number").notNull(),
  customerId: integer("customer_id"),
  customerName: text("customer_name").notNull(),
  dealId: integer("deal_id"),
  applicationId: integer("application_id"),
  description: text("description"),
  amount: doublePrecision("amount").notNull(),
  status: text("status").notNull().default("issued"),
  dueDate: text("due_date"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertInvoiceSchema = createInsertSchema(invoicesTable, {
  status: z.enum(INVOICE_STATUSES),
}).omit({ dealerId: true, id: true, createdAt: true, invoiceNumber: true });
export type InsertInvoice = z.infer<typeof insertInvoiceSchema>;
export type Invoice = typeof invoicesTable.$inferSelect;
