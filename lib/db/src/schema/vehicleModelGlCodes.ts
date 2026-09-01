import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Vehicle model GL codes (Finance): one dealership-scoped GL account code per
// normalized make/model. Every variant, trim, year and VIN under the same
// normalized make/model inherits the mapping — never one code per VIN.
// ---------------------------------------------------------------------------

/**
 * THE single normalizer for make/model identity. Inventory grouping, mapping
 * lookup and accounting-sync resolution must all go through this function so
 * "BYD  Sealion 7", "byd sealion 7" and "BYD SEALION 7" are one model.
 */
export function normalizeModelKey(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

export const VEHICLE_MODEL_GL_ERPNEXT_STATUSES = [
  "verified",
  "invalid",
] as const;
export type VehicleModelGlErpnextStatus =
  (typeof VEHICLE_MODEL_GL_ERPNEXT_STATUSES)[number];

export const vehicleModelGlCodesTable = pgTable(
  "vehicle_model_gl_codes",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    /** Normalized identity (see normalizeModelKey). */
    makeKey: text("make_key").notNull(),
    modelKey: text("model_key").notNull(),
    /** Display labels as last seen in inventory / the edit form. */
    makeLabel: text("make_label").notNull(),
    modelLabel: text("model_label").notNull(),
    /** Dealer GL account code — unique per dealership. */
    glCode: text("gl_code").notNull(),
    accountName: text("account_name"),
    /** Last ERPNext Chart-of-Accounts check result (verified | invalid);
     * null = never checked (or code changed since the last check). */
    erpnextStatus: text("erpnext_status"),
    erpnextCheckedAt: timestamp("erpnext_checked_at", { withTimezone: true }),
    updatedBy: text("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("vehicle_model_gl_codes_model_uq").on(
      t.dealerId,
      t.makeKey,
      t.modelKey,
    ),
    uniqueIndex("vehicle_model_gl_codes_code_uq").on(t.dealerId, t.glCode),
  ],
);
export type VehicleModelGlCode = typeof vehicleModelGlCodesTable.$inferSelect;
