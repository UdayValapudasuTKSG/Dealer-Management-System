import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { customersTable } from "./customers";
import { dealersTable } from "./dealers";
import { serviceOrdersTable } from "./serviceOrders";

/** A customer-entered vehicle in their garage. It is deliberately unrelated
 * to inventory/VIN stock units. */
export const garageVehiclesTable = pgTable("garage_vehicles", {
  id: serial("id").primaryKey(),
  dealerId: integer("dealer_id").notNull().references(() => dealersTable.id),
  customerId: integer("customer_id").notNull().references(() => customersTable.id),
  registration: text("registration").notNull(),
  vinChassis: text("vin_chassis"),
  make: text("make").notNull(),
  model: text("model").notNull(),
  year: integer("year"),
  colour: text("colour"),
  mileage: integer("mileage"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("garage_vehicles_dealer_customer_registration_uq")
    .on(t.dealerId, t.customerId, t.registration),
]);

export const vehicleOnboardingRequestsTable = pgTable("vehicle_onboarding_requests", {
  id: serial("id").primaryKey(),
  dealerId: integer("dealer_id").notNull().references(() => dealersTable.id),
  customerId: integer("customer_id").notNull().references(() => customersTable.id),
  serviceOrderId: integer("service_order_id").references(() => serviceOrdersTable.id),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  garageVehicleId: integer("garage_vehicle_id").references(() => garageVehiclesTable.id),
  invitedByUserId: integer("invited_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("vehicle_onboarding_requests_token_hash_uq").on(t.tokenHash),
  index("vehicle_onboarding_requests_service_order_idx").on(t.serviceOrderId),
]);

export const vehicleOnboardingMediaTable = pgTable("vehicle_onboarding_media", {
  id: serial("id").primaryKey(),
  requestId: integer("request_id").notNull()
    .references(() => vehicleOnboardingRequestsTable.id, { onDelete: "cascade" }),
  dealerId: integer("dealer_id").notNull().references(() => dealersTable.id),
  customerId: integer("customer_id").notNull().references(() => customersTable.id),
  garageVehicleId: integer("garage_vehicle_id").references(() => garageVehiclesTable.id),
  objectPath: text("object_path").notNull(),
  kind: text("kind").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  originalName: text("original_name"),
  finalizedAt: timestamp("finalized_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("vehicle_onboarding_media_object_path_uq").on(t.objectPath),
  check("vehicle_onboarding_media_kind_ck", sql`${t.kind} in ('image', 'video')`),
  // Zero is permitted only before server-side metadata finalization.
  check("vehicle_onboarding_media_size_ck", sql`(${t.finalizedAt} is null and ${t.sizeBytes} = 0) or (${t.finalizedAt} is not null and ${t.sizeBytes} > 0 and ${t.sizeBytes} <= 2147483647)`),
]);

export type GarageVehicle = typeof garageVehiclesTable.$inferSelect;
export type VehicleOnboardingRequest = typeof vehicleOnboardingRequestsTable.$inferSelect;
export type VehicleOnboardingMedia = typeof vehicleOnboardingMediaTable.$inferSelect;