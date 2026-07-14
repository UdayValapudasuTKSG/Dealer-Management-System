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

export const PERMISSION_MODULES = [
  "dashboard",
  "inventory",
  "leads",
  "deals",
  "appraisals",
  "finance",
  "service",
  "customers",
  "approvals",
  "gra",
  "settings",
] as const;
export type PermissionModule = (typeof PERMISSION_MODULES)[number];

export const PERMISSION_CATEGORIES = [
  "view",
  "create",
  "edit",
  "delete",
  "approve",
  "reject",
  "export",
  "assign",
  "admin",
] as const;
export type PermissionCategory = (typeof PERMISSION_CATEGORIES)[number];

export const rolesTable = pgTable("roles", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  description: text("description"),
  isSystem: boolean("is_system").notNull().default(false),
  createdBy: text("created_by"),
  updatedBy: text("updated_by"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const rolePermissionsTable = pgTable(
  "role_permissions",
  {
    id: serial("id").primaryKey(),
    roleId: integer("role_id")
      .notNull()
      .references(() => rolesTable.id, { onDelete: "cascade" }),
    module: text("module").notNull(),
    category: text("category").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("role_permissions_role_module_category_idx").on(
      t.roleId,
      t.module,
      t.category,
    ),
  ],
);

export const insertRoleSchema = createInsertSchema(rolesTable).omit({
  id: true,
  createdAt: true,
});
export const insertRolePermissionSchema = createInsertSchema(
  rolePermissionsTable,
  {
    module: z.enum(PERMISSION_MODULES),
    category: z.enum(PERMISSION_CATEGORIES),
  },
).omit({ id: true, createdAt: true });

export type InsertRole = z.infer<typeof insertRoleSchema>;
export type Role = typeof rolesTable.$inferSelect;
export type InsertRolePermission = z.infer<typeof insertRolePermissionSchema>;
export type RolePermission = typeof rolePermissionsTable.$inferSelect;
