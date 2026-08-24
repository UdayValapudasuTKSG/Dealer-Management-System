import {
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Per-dealer Meta Lead Ads connection credentials.
// One row per dealer. The Facebook Page ID itself stays on dealers.metaPageId
// (routing); this table holds the dealer's own Meta app credentials so a GM
// can self-serve the whole setup from Settings. Global env credentials remain
// as a platform-level fallback.
// Page token + app secret are stored encrypted (AES-256-GCM); never returned.
// The verify token is readable by the GM — they must paste it into the Meta
// App dashboard (same reasoning as the ERPNext webhook shared secret).
// ---------------------------------------------------------------------------

export const metaConnectionsTable = pgTable(
  "meta_connections",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    /**
     * AES-256-GCM ciphertext of the Page access token, base64 wire format
     * <iv>:<tag>:<ciphertext>. Never returned to the client.
     */
    pageAccessTokenCiphertext: text("page_access_token_ciphertext"),
    /** AES-256-GCM ciphertext of the Meta app secret. Never returned. */
    appSecretCiphertext: text("app_secret_ciphertext"),
    /** Webhook verify token — GM-readable, pasted into the Meta dashboard. */
    verifyToken: text("verify_token"),
    /** Last connection test: "connected" | "error" | null (never tested). */
    lastStatus: text("last_status"),
    /** Human-readable error from the last test, if any. */
    lastError: text("last_error"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("meta_connections_dealer_uq").on(t.dealerId)],
);

export type MetaConnection = typeof metaConnectionsTable.$inferSelect;
