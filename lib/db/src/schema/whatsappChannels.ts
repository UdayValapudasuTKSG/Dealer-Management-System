import {
  boolean,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Per-dealer Meta WhatsApp Business channel configuration.
// One row per dealer; phone_number_id is globally unique across all dealers.
// Access tokens are stored encrypted (AES-256-GCM); never returned plaintext.
// ---------------------------------------------------------------------------

export const whatsappChannelsTable = pgTable(
  "whatsapp_channels",
  {
    id: serial("id").primaryKey(),
    /** The owning dealership. One channel per dealer. */
    dealerId: integer("dealer_id").notNull(),
    /** Meta WhatsApp Business Account ID. */
    wabaId: text("waba_id").notNull(),
    /** Meta phone number ID — globally unique across the platform. */
    phoneNumberId: text("phone_number_id").notNull(),
    /** Human-readable display phone number (e.g. +1 555 123 4567). */
    displayPhoneNumber: text("display_phone_number"),
    /** Verified name as registered with Meta. */
    verifiedName: text("verified_name"),
    /** Master switch: false pauses all sends without losing config. */
    enabled: boolean("enabled").notNull().default(true),
    /**
     * Optional approved Meta template used when a free-form reply is outside
     * the 24-hour customer-service window. The template must have exactly one
     * body text variable; AURA supplies the intended message as that variable.
     */
    serviceTemplateName: text("service_template_name"),
    serviceTemplateLanguage: text("service_template_language")
      .notNull()
      .default("en_US"),
    /**
     * AES-256-GCM ciphertext of the access token, base64-encoded.
     * Format: <iv_b64>:<tag_b64>:<ciphertext_b64>
     * Never returned to the client; only hasAccessToken is exposed.
     */
    accessTokenCiphertext: text("access_token_ciphertext"),
    /**
     * AES-256-GCM ciphertext of the Meta app secret used to verify inbound
     * webhook signatures for this channel's app. Same wire format as the
     * access token. Optional: when absent, the platform-level META_APP_SECRET
     * env fallback is used. Never returned to the client; only hasAppSecret.
     */
    appSecretCiphertext: text("app_secret_ciphertext"),
    /** Last health check result: "connected" | "error" | null (never tested). */
    lastStatus: text("last_status"),
    /** Human-readable error from the last test call, if any. */
    lastError: text("last_error"),
    /** When the last test/health check was performed. */
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("whatsapp_channels_dealer_uq").on(t.dealerId),
    uniqueIndex("whatsapp_channels_phone_number_id_uq").on(t.phoneNumberId),
    index("whatsapp_channels_dealer_idx").on(t.dealerId),
  ],
);

export type WhatsappChannel = typeof whatsappChannelsTable.$inferSelect;
