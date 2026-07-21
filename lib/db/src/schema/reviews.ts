import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Post-delivery CSAT / customer reviews (spec R1 / V1 2.15). The delivery
 * workflow's feedback step writes one row here on completion; staff can also
 * log reviews captured through other channels. Rating is 1–5.
 */
export const REVIEW_SOURCES = [
  "delivery_csat",
  "service_csat",
  "manual",
] as const;
export type ReviewSource = (typeof REVIEW_SOURCES)[number];

export const reviewsTable = pgTable(
  "reviews",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    customerId: integer("customer_id"),
    customerName: text("customer_name"),
    source: text("source").notNull().default("manual"),
    rating: integer("rating").notNull(),
    comment: text("comment"),
    /** What the review is about: delivery | deal | service_order | general. */
    refType: text("ref_type"),
    refId: integer("ref_id"),
    vehicleLabel: text("vehicle_label"),
    capturedBy: text("captured_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("reviews_dealer_customer_idx").on(t.dealerId, t.customerId),
    index("reviews_dealer_created_idx").on(t.dealerId, t.createdAt),
  ],
);

export const insertReviewSchema = createInsertSchema(reviewsTable, {
  source: z.enum(REVIEW_SOURCES),
  rating: z.number().int().min(1).max(5),
}).omit({ dealerId: true, id: true, createdAt: true });
export type InsertReview = z.infer<typeof insertReviewSchema>;
export type Review = typeof reviewsTable.$inferSelect;
