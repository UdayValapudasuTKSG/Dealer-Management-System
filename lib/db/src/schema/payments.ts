import {
  pgTable,
  serial,
  text,
  integer,
  doublePrecision,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { isNotNull } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { invoicesTable } from "./invoices";

export const PAYMENT_METHODS = [
  "cash",
  "card",
  "bank_transfer",
  "cheque",
  "mobile_money",
  "financing",
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const paymentsTable = pgTable("payments", {
  id: serial("id").primaryKey(),
  dealerId: integer("dealer_id").notNull(),
  invoiceId: integer("invoice_id")
    .notNull()
    .references(() => invoicesTable.id, { onDelete: "cascade" }),
  customerName: text("customer_name").notNull(),
  amount: doublePrecision("amount").notNull(),
  method: text("method").notNull().default("bank_transfer"),
  reference: text("reference"),
  receivedBy: text("received_by"),
  /** L9: links a refund ledger entry to the approving refund_release gate. */
  gateId: integer("gate_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (t) => [
  /** L9: at most ONE refund ledger row per refund_release gate (race-proof). */
  uniqueIndex("payments_gate_id_unique").on(t.gateId).where(isNotNull(t.gateId)),
]);

export const insertPaymentSchema = createInsertSchema(paymentsTable, {
  method: z.enum(PAYMENT_METHODS),
}).omit({ dealerId: true, id: true, createdAt: true });
export type InsertPayment = z.infer<typeof insertPaymentSchema>;
export type Payment = typeof paymentsTable.$inferSelect;

export const receiptsTable = pgTable("receipts", {
  id: serial("id").primaryKey(),
  dealerId: integer("dealer_id").notNull(),
  receiptNumber: text("receipt_number").notNull(),
  paymentId: integer("payment_id")
    .notNull()
    .references(() => paymentsTable.id, { onDelete: "cascade" }),
  invoiceId: integer("invoice_id").notNull(),
  invoiceNumber: text("invoice_number").notNull(),
  customerName: text("customer_name").notNull(),
  amount: doublePrecision("amount").notNull(),
  method: text("method").notNull(),
  /** USD-scale amount; GYD display reproducible via the snapshot rate. */
  currency: text("currency").notNull().default("GYD"),
  exchangeRate: doublePrecision("exchange_rate"),
  issuedBy: text("issued_by"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Receipt = typeof receiptsTable.$inferSelect;
