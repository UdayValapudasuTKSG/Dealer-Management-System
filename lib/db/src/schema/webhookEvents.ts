import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { serviceOrdersTable } from "./serviceOrders";

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
    // Gmail service-form deliveries point at the created booking so the
    // existing intake/governance review UI can show the result without
    // introducing a second email ledger.
    serviceOrderId: integer("service_order_id").references(
      () => serviceOrdersTable.id,
    ),
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
