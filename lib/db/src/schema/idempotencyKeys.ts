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
 * Idempotency store (NC-7). A client sends an `X-Idempotency-Key` header on
 * mutations; the first execution records an in-flight row with the request
 * body fingerprint, then persists the response on completion.
 *
 * Semantics driven by this table:
 *  - replay of a COMPLETED request (same key + same body hash) → stored
 *    response returned verbatim, no re-execution;
 *  - duplicate while the original is still IN FLIGHT → 409;
 *  - same key with a DIFFERENT body hash → 422 `key_reuse_mismatch`.
 */
export const idempotencyKeysTable = pgTable(
  "idempotency_keys",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    key: text("key").notNull(),
    endpoint: text("endpoint").notNull(),
    // SHA-256 hex fingerprint of the request body (NC-7 key-reuse detection).
    bodyHash: text("body_hash"),
    // in_flight | completed — drives 409 on concurrent duplicates.
    state: text("state").notNull().default("completed"),
    statusCode: integer("status_code"),
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
