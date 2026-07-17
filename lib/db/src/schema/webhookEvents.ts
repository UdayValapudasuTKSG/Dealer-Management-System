import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Idempotency ledger for inbound webhooks (Meta leadgen retries, Twilio
// message redeliveries). One row per processed external event.
export const webhookEventsTable = pgTable(
  "webhook_events",
  {
    id: serial("id").primaryKey(),
  dealerId: integer("dealer_id"),
    channel: text("channel").notNull(), // "meta_leadgen" | "twilio_whatsapp"
    externalId: text("external_id").notNull(),
    leadId: integer("lead_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("webhook_events_channel_external_idx").on(
      t.channel,
      t.externalId,
    ),
  ],
);

export type WebhookEvent = typeof webhookEventsTable.$inferSelect;
