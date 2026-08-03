import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { rolesTable } from "./roles";

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  clerkId: text("clerk_id").notNull().unique(),
  email: text("email"),
  name: text("name"),
  phone: text("phone"),
  imageUrl: text("image_url"),
  roleId: integer("role_id").references(() => rolesTable.id, {
    onDelete: "set null",
  }),
  status: text("status").notNull().default("active"),
  createdBy: text("created_by"),
  updatedBy: text("updated_by"),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  // NC-14 default-dealer resolution: the dealer this user last worked in.
  // Used when a data-plane GET arrives without an x-dealer-id header
  // (lastActive → sole membership → picker payload).
  lastActiveDealerId: integer("last_active_dealer_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertUserSchema = createInsertSchema(usersTable, {
  status: z.enum(["active", "suspended"]),
}).omit({ id: true, createdAt: true, updatedAt: true });

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
