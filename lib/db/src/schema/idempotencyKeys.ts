import {
  pgTable,
  serial,
  text,
  integer,
  jsonb,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Stored responses for idempotent mutation replay. A client sends an
 * `X-Idempotency-Key` header on payment / invoice / allocation operations;
 * a retry with the same key returns the stored response instead of
 * executing the mutation twice.
 */
export const idempotencyKeysTable = pgTable(
  "idempotency_keys",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    key: text("key").notNull(),
    endpoint: text("endpoint").notNull(),
    statusCode: integer("status_code").notNull(),
    responseBody: jsonb("response_body").$type<unknown>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("idempotency_keys_dealer_key_endpoint_idx").on(
      t.dealerId,
      t.key,
      t.endpoint,
    ),
  ],
);

export type IdempotencyKey = typeof idempotencyKeysTable.$inferSelect;
