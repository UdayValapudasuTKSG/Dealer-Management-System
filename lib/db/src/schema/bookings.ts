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

export const BOOKING_STATUSES = [
  "active",
  "converted",
  "expired",
  "cancelled",
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const BOOKING_PAYMENT_STATUSES = [
  "pending",
  "partial",
  "paid",
  "refunded",
] as const;
export type BookingPaymentStatus = (typeof BOOKING_PAYMENT_STATUSES)[number];

export const bookingsTable = pgTable("bookings", {
  id: serial("id").primaryKey(),
  dealerId: integer("dealer_id").notNull(),
  vehicleId: integer("vehicle_id").notNull(),
  customerId: integer("customer_id"),
  customerName: text("customer_name").notNull(),
  leadId: integer("lead_id"),
  dealId: integer("deal_id"),
  // Trusted-customer fee bypass: set (with a manager-approval gate) when the
  // reservation is taken with bookingAmount=0 for a fleet/repeat VIP buyer.
  waiverReason: text("waiver_reason"),
  bookingAmount: doublePrecision("booking_amount").notNull(),
  amountPaid: doublePrecision("amount_paid").notNull().default(0),
  paymentStatus: text("payment_status").notNull().default("pending"),
  status: text("status").notNull().default("active"),
  cancellationReason: text("cancellation_reason"),
  cancellationNote: text("cancellation_note"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  notes: text("notes"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertBookingSchema = createInsertSchema(bookingsTable, {
  status: z.enum(BOOKING_STATUSES),
  paymentStatus: z.enum(BOOKING_PAYMENT_STATUSES),
}).omit({ dealerId: true, id: true, createdAt: true });
export type InsertBooking = z.infer<typeof insertBookingSchema>;
export type Booking = typeof bookingsTable.$inferSelect;
