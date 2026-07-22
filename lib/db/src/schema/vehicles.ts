import {
  pgTable,
  serial,
  text,
  integer,
  doublePrecision,
  boolean,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { divisionsTable } from "./divisions";

export const VEHICLE_STATUSES = [
  "available",
  "reserved",
  "booked",
  "delivered",
  "in_transit",
  "sold",
  "service",
  "under_repair",
] as const;
export type VehicleStatus = (typeof VEHICLE_STATUSES)[number];

/** Allowed stock-status transitions for the booking/delivery lifecycle. */
export const VEHICLE_STATUS_TRANSITIONS: Record<string, readonly string[]> = {
  available: ["reserved", "booked", "in_transit", "service", "under_repair", "sold"],
  reserved: ["booked", "available"],
  booked: ["delivered", "available"],
  delivered: ["sold"],
  in_transit: ["available"],
  service: ["available", "under_repair"],
  under_repair: ["available", "service"],
  sold: [],
};

export const vehicleDocumentSchema = z.object({
  name: z.string().min(1),
  url: z.string().min(1),
});
export type VehicleDocument = z.infer<typeof vehicleDocumentSchema>;

/** DMS spec: VIN and Engine # are exactly 17 characters. */
export const VIN_LENGTH = 17;
/** DMS spec: registration plates are 3 letters followed by 1-4 digits. */
export const REGISTRATION_PATTERN = /^[A-Z]{3}[0-9]{1,4}$/;

export const vehiclesTable = pgTable("vehicles", {
  id: serial("id").primaryKey(),
  dealerId: integer("dealer_id").notNull(),
  divisionId: integer("division_id").references(() => divisionsTable.id),
  make: text("make").notNull(),
  model: text("model").notNull(),
  trim: text("trim"),
  year: integer("year").notNull(),
  vin: text("vin"),
  engineNumber: text("engine_number"),
  registration: text("registration"),
  variant: text("variant"),
  engine: text("engine"),
  transmission: text("transmission"),
  price: doublePrecision("price").notNull(),
  powertrain: text("powertrain").notNull(),
  rangeKm: integer("range_km"),
  mileageKm: integer("mileage_km").notNull(),
  exteriorColor: text("exterior_color").notNull(),
  bodyType: text("body_type").notNull(),
  status: text("status").notNull().default("available"),
  /** Soft lock: single-unit models are held around a booked test drive. */
  holdUntil: timestamp("hold_until", { withTimezone: true }),
  holdReason: text("hold_reason"),
  imageUrl: text("image_url"),
  images: jsonb("images").$type<string[]>().notNull().default([]),
  accessories: jsonb("accessories").$type<string[]>().notNull().default([]),
  documents: jsonb("documents")
    .$type<VehicleDocument[]>()
    .notNull()
    .default([]),
  description: text("description"),
  featured: boolean("featured").notNull().default(false),
  // Soft delete (R4.8): rows are never hard-removed from the data plane.
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: text("deleted_by"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertVehicleSchema = createInsertSchema(vehiclesTable, {
  status: z.enum(VEHICLE_STATUSES),
  images: z.array(z.string()),
  accessories: z.array(z.string()),
  documents: z.array(vehicleDocumentSchema),
  vin: z.string().length(VIN_LENGTH).nullable().optional(),
  engineNumber: z.string().length(VIN_LENGTH).nullable().optional(),
  registration: z.string().regex(REGISTRATION_PATTERN).nullable().optional(),
}).omit({ dealerId: true,
  id: true,
  createdAt: true,
});
export type InsertVehicle = z.infer<typeof insertVehicleSchema>;
export type Vehicle = typeof vehiclesTable.$inferSelect;
