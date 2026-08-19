import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

// Full WhatsApp chat transcript: every inbound customer message and every
// outbound message (bot prompts + staff replies), linked to the lead once one
// exists so the lead page can render the conversation chronologically.
export const whatsappMessagesTable = pgTable(
  "whatsapp_messages",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id"),
    /** Linked lead — null while the guided flow is still pre-lead; backfilled by phone. */
    leadId: integer("lead_id"),
    /** Customer WhatsApp id (E.164 digits, no "+"). */
    phone: text("phone").notNull(),
    /** "in" = from customer, "out" = bot/staff to customer. */
    direction: text("direction").notNull(),
    body: text("body").notNull(),
    /** Sender label for outbound ("AURA WhatsApp Bot" or staff name); null inbound. */
    actor: text("actor"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Dealer-scoped phone index for efficient per-dealer lookups.
    index("whatsapp_messages_dealer_phone_idx").on(t.dealerId, t.phone),
    index("whatsapp_messages_phone_idx").on(t.phone),
    index("whatsapp_messages_lead_idx").on(t.leadId),
  ],
);

export type WhatsappMessage = typeof whatsappMessagesTable.$inferSelect;
