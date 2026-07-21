import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { dealersTable } from "./dealers";

/**
 * Dealer-configurable lead sources. Drives the lead-form source dropdown.
 * Sources flagged `isSocial` require a sub-platform (`sourceDetail` on the
 * lead) when selected.
 */
export const SOCIAL_SUB_PLATFORMS = [
  "facebook",
  "instagram",
  "tiktok",
  "youtube",
  "whatsapp",
  "other",
] as const;
export type SocialSubPlatform = (typeof SOCIAL_SUB_PLATFORMS)[number];

export const leadSourcesTable = pgTable(
  "lead_sources",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id")
      .notNull()
      .references(() => dealersTable.id, { onDelete: "cascade" }),
    /** Stable machine code stored on leads (e.g. "walk_in"). */
    code: text("code").notNull(),
    name: text("name").notNull(),
    isSocial: boolean("is_social").notNull().default(false),
    active: boolean("active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("lead_sources_dealer_code_idx").on(t.dealerId, t.code)],
);

export const insertLeadSourceSchema = createInsertSchema(
  leadSourcesTable,
).omit({ id: true, createdAt: true });
export type InsertLeadSource = z.infer<typeof insertLeadSourceSchema>;
export type LeadSourceRecord = typeof leadSourcesTable.$inferSelect;

/** Defaults seeded per dealer the first time the config is read. */
export const DEFAULT_LEAD_SOURCES: readonly {
  code: string;
  name: string;
  isSocial: boolean;
}[] = [
  { code: "website", name: "Website", isSocial: false },
  { code: "walk_in", name: "Walk-in", isSocial: false },
  { code: "phone", name: "Phone", isSocial: false },
  { code: "facebook", name: "Facebook", isSocial: true },
  { code: "instagram", name: "Instagram", isSocial: true },
  { code: "whatsapp", name: "WhatsApp", isSocial: true },
  { code: "referral", name: "Referral", isSocial: false },
  { code: "gmail", name: "Email (Gmail intake)", isSocial: false },
] as const;
