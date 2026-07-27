import {
  pgTable,
  serial,
  text,
  integer,
  doublePrecision,
  timestamp,
  date,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * R10.3 per-channel marketing consent. Keyed by channel (email | whatsapp |
 * sms | phone). Absence of a channel key means NO consent (opt-in model).
 * Never upgraded on merge — intake dedup carries the strictest value forward.
 */
export interface MarketingConsentEntry {
  granted: boolean;
  basis: string; // e.g. "web_form_checkbox", "whatsapp_inbound_optin"
  capturedAt: string; // ISO timestamp
  sourceEvent: string; // e.g. "enquiry:123", "whatsapp:+592..."
}
export type MarketingConsent = Record<string, MarketingConsentEntry>;

export const customersTable = pgTable("customers", {
  id: serial("id").primaryKey(),
  dealerId: integer("dealer_id").notNull(),
  // Person or Business account. Business accounts hold multiple contacts.
  accountType: text("account_type").notNull().default("person"),
  // Manual grouping: household head or parent business account (same dealer).
  parentAccountId: integer("parent_account_id"),
  name: text("name").notNull(),
  email: text("email"),
  phone: text("phone"),
  whatsapp: text("whatsapp"),
  dateOfBirth: date("date_of_birth", { mode: "string" }),
  occupation: text("occupation"),
  company: text("company"),
  address: text("address"),
  country: text("country"),
  city: text("city"),
  taxNumber: text("tax_number"),
  tags: text("tags")
    .array()
    .notNull()
    .default([] as string[]),
  avatarUrl: text("avatar_url"),
  location: text("location"),
  lifetimeValue: doublePrecision("lifetime_value").notNull().default(0),
  vehiclesOwned: integer("vehicles_owned").notNull().default(0),
  loyaltyTier: text("loyalty_tier").notNull().default("new"),
  // R10.3 per-channel marketing consent (opt-in; absent key = not granted).
  marketingConsent: jsonb("marketing_consent").$type<MarketingConsent>(),
  // R10.5 erasure: set when the row has been anonymized into a shell record
  // (C1/C2 tokenized, C4/C5 purged, C3 retained de-linked).
  erasedAt: timestamp("erased_at", { withTimezone: true }),
  // Soft delete (R4.8): rows are never hard-removed from the data plane.
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: text("deleted_by"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertCustomerSchema = createInsertSchema(customersTable, {
  loyaltyTier: z.enum(["new", "silver", "gold", "platinum"]),
  accountType: z.enum(["person", "business"]),
}).omit({ dealerId: true,
  id: true,
  createdAt: true,
});
export type InsertCustomer = z.infer<typeof insertCustomerSchema>;
export type Customer = typeof customersTable.$inferSelect;
