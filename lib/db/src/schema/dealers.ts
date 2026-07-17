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
import { rolesTable } from "./roles";
import { usersTable } from "./users";

export const dealersTable = pgTable("dealers", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  city: text("city"),
  country: text("country"),
  status: text("status").notNull().default("active"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const dealerUsersTable = pgTable(
  "dealer_users",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id")
      .notNull()
      .references(() => dealersTable.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    roleId: integer("role_id")
      .notNull()
      .references(() => rolesTable.id),
    isGeneralManager: boolean("is_general_manager").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("dealer_users_dealer_user_idx").on(t.dealerId, t.userId)],
);

export const insertDealerSchema = createInsertSchema(dealersTable, {
  status: z.enum(["active", "inactive"]),
}).omit({ id: true, createdAt: true });
export type InsertDealer = z.infer<typeof insertDealerSchema>;
export type Dealer = typeof dealersTable.$inferSelect;

export const insertDealerUserSchema = createInsertSchema(
  dealerUsersTable,
).omit({ id: true, createdAt: true });
export type InsertDealerUser = z.infer<typeof insertDealerUserSchema>;
export type DealerUser = typeof dealerUsersTable.$inferSelect;
