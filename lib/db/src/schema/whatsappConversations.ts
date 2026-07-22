import {
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// In-flight guided WhatsApp lead-capture conversations (Meta Cloud API bot).
// One active session per phone; expired rows are replaced on next contact.
export const whatsappConversationsTable = pgTable(
  "whatsapp_conversations",
  {
    id: serial("id").primaryKey(),
    /** WhatsApp sender id (E.164 digits, no "+" — as Meta sends it). */
    phone: text("phone").notNull(),
    /** Current step: "name" | "mobile" | "email" | "brand" | "model" */
    step: text("step").notNull().default("name"),
    /** Selected vehicle make while on the "model" step. */
    brand: text("brand"),
    name: text("name"),
    mobile: text("mobile"),
    email: text("email"),
    /** WhatsApp profile name, kept as a fallback label. */
    profileName: text("profile_name"),
    /**
     * JSON array of option ids last presented to the customer (e.g.
     * ["use_this_number"] or ["veh_3", ..., "veh_other"]). Lets text-only
     * transports (Twilio) map numbered replies back to option ids.
     */
    menu: text("menu"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("whatsapp_conversations_phone_idx").on(t.phone)],
);

export type WhatsappConversation =
  typeof whatsappConversationsTable.$inferSelect;
