import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { rolesTable } from "./roles";

/**
 * Field-level access control: per role, per named field group.
 * Roles WITHOUT a row for a group default to full ("edit") access, so the
 * feature is opt-in and existing behavior is preserved.
 */
export const FIELD_ACCESS_LEVELS = ["hidden", "view", "edit"] as const;
export type FieldAccessLevel = (typeof FIELD_ACCESS_LEVELS)[number];

export type FieldGroupDef = {
  key: string;
  label: string;
  module: "leads" | "inventory" | "deals";
  /** Record fields the group governs (edit-blocking applies to all). */
  fields: readonly string[];
  /**
   * Subset of `fields` that are nullable in API responses and can therefore
   * be redacted (nulled) when access is "hidden". Non-nullable fields cannot
   * be redacted without breaking response contracts, so "hidden" falls back
   * to view-only for them.
   */
  redactable: readonly string[];
};

export const FIELD_GROUPS: readonly FieldGroupDef[] = [
  {
    key: "lead_contact",
    label: "Lead · Contact details",
    module: "leads",
    fields: ["email", "phone", "address"],
    redactable: ["email", "phone", "address"],
  },
  {
    key: "lead_qualification",
    label: "Lead · Qualification notes",
    module: "leads",
    fields: [
      "budgetFinancing",
      "purchaseIntent",
      "keyInterestDriver",
      "description",
      "notes",
    ],
    redactable: [
      "budgetFinancing",
      "purchaseIntent",
      "keyInterestDriver",
      "description",
      "notes",
    ],
  },
  {
    key: "lead_commercials",
    label: "Lead · Commercial flags",
    module: "leads",
    fields: [
      "quotationSent",
      "reservationFeePaid",
      "reservationComments",
      "financingQualified",
      "closureReason",
      "purchaseType",
    ],
    redactable: ["reservationComments", "closureReason", "purchaseType"],
  },
  {
    key: "vehicle_pricing",
    label: "Vehicle · Pricing",
    module: "inventory",
    fields: ["price", "dutyFreeAmount"],
    redactable: [],
  },
  {
    key: "vehicle_identity",
    label: "Vehicle · VIN / engine / registration",
    module: "inventory",
    fields: ["year", "vin", "engineNumber", "registration"],
    redactable: ["vin", "engineNumber", "registration"],
  },
  {
    key: "deal_financials",
    label: "Deal · Financial figures",
    module: "deals",
    fields: [
      "vehiclePrice",
      "discount",
      "tradeInValue",
      "accessories",
      "otdPrice",
      "monthlyPayment",
      "depositPaid",
    ],
    redactable: ["monthlyPayment"],
  },
] as const;

export const FIELD_GROUP_KEYS = FIELD_GROUPS.map((g) => g.key);

export const roleFieldPermissionsTable = pgTable(
  "role_field_permissions",
  {
    id: serial("id").primaryKey(),
    roleId: integer("role_id")
      .notNull()
      .references(() => rolesTable.id, { onDelete: "cascade" }),
    fieldGroup: text("field_group").notNull(),
    access: text("access").notNull().default("edit"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("role_field_permissions_role_group_idx").on(
      t.roleId,
      t.fieldGroup,
    ),
  ],
);

export const insertRoleFieldPermissionSchema = createInsertSchema(
  roleFieldPermissionsTable,
  { access: z.enum(FIELD_ACCESS_LEVELS) },
).omit({ id: true, createdAt: true });

export type InsertRoleFieldPermission = z.infer<
  typeof insertRoleFieldPermissionSchema
>;
export type RoleFieldPermission =
  typeof roleFieldPermissionsTable.$inferSelect;
