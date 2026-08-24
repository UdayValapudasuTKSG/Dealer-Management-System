import {
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// In-flight guided WhatsApp lead-capture conversations (Meta Cloud API bot).
// One active session per (dealer, phone); expired rows are replaced on next contact.
export const whatsappConversationsTable = pgTable(
  "whatsapp_conversations",
  {
    id: serial("id").primaryKey(),
    /**
     * Owning dealership. NOT NULL — every conversation belongs to a dealer
     * so that multi-tenant deployments stay isolated. Backfilled to dealer 2
     * for pre-existing rows in the 2026-08-20 migration.
     */
    dealerId: integer("dealer_id").notNull(),
    /** WhatsApp sender id (E.164 digits, no "+" — as Meta sends it). */
    phone: text("phone").notNull(),
    /** Current step: "name" | "mobile" | "email" | "address" | "brand" | "model" | "confirm" */
    step: text("step").notNull().default("name"),
    /** Selected vehicle make while on the "model" step. */
    brand: text("brand"),
    name: text("name"),
    mobile: text("mobile"),
    email: text("email"),
    address: text("address"),
    /** Available inventory unit selected during the AI-guided conversation. */
    interestedVehicleId: integer("interested_vehicle_id"),
    /** WhatsApp profile name, kept as a fallback label. */
    profileName: text("profile_name"),
    /**
     * JSON array of option ids last presented to the customer (e.g.
     * ["use_this_number"] or ["veh_3", ..., "veh_other"]). Lets text-only
     * transports (Twilio) map numbered replies back to option ids.
     */
    menu: text("menu"),
    /**
     * R6.4 explicit opt-out: set when the customer sends STOP/UNSUBSCRIBE (or
     * clears the preference). While set, ALL outbound WhatsApp to this phone
     * is suppressed and downgraded to Email → In-App. Cleared by "START".
     */
    optedOutAt: timestamp("opted_out_at", { withTimezone: true }),
    /**
     * Structured memory for the conversational AI concierge (JSON text):
     * accumulated facts (budget, trade-in, financing interest, vehicle under
     * discussion, summary…) that must survive across messages and restarts.
     * Null when the deterministic guided flow is driving the conversation.
     */
    aiContext: text("ai_context"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Composite unique: one active session per (dealer, phone).
    uniqueIndex("whatsapp_conversations_dealer_phone_idx").on(t.dealerId, t.phone),
  ],
);

export type WhatsappConversation =
  typeof whatsappConversationsTable.$inferSelect;
