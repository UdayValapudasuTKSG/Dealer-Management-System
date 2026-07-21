import {
  pgTable,
  serial,
  text,
  integer,
  doublePrecision,
  timestamp,
  date,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

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
