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

export const VEHICLE_STATUSES = [
  "available",
  "reserved",
  "booked",
  "delivered",
  "in_transit",
  "sold",
  "service",
] as const;
export type VehicleStatus = (typeof VEHICLE_STATUSES)[number];

/** Allowed stock-status transitions for the booking/delivery lifecycle. */
export const VEHICLE_STATUS_TRANSITIONS: Record<string, readonly string[]> = {
  available: ["reserved", "booked", "in_transit", "service", "sold"],
  reserved: ["booked", "available"],
  booked: ["delivered", "available"],
  delivered: [],
  in_transit: ["available"],
  service: ["available"],
  sold: [],
};

export const vehicleDocumentSchema = z.object({
  name: z.string().min(1),
  url: z.string().min(1),
});
export type VehicleDocument = z.infer<typeof vehicleDocumentSchema>;

export const vehiclesTable = pgTable("vehicles", {
  id: serial("id").primaryKey(),
  dealerId: integer("dealer_id").notNull(),
  make: text("make").notNull(),
  model: text("model").notNull(),
  trim: text("trim"),
  year: integer("year").notNull(),
  vin: text("vin"),
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
  imageUrl: text("image_url"),
  images: jsonb("images").$type<string[]>().notNull().default([]),
  accessories: jsonb("accessories").$type<string[]>().notNull().default([]),
  documents: jsonb("documents")
    .$type<VehicleDocument[]>()
    .notNull()
    .default([]),
  description: text("description"),
  featured: boolean("featured").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertVehicleSchema = createInsertSchema(vehiclesTable, {
  status: z.enum(VEHICLE_STATUSES),
  images: z.array(z.string()),
  accessories: z.array(z.string()),
  documents: z.array(vehicleDocumentSchema),
}).omit({ dealerId: true,
  id: true,
  createdAt: true,
});
export type InsertVehicle = z.infer<typeof insertVehicleSchema>;
export type Vehicle = typeof vehiclesTable.$inferSelect;
