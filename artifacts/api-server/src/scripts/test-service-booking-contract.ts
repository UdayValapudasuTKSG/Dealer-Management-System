import assert from "node:assert/strict";
import {
  CreateServiceOrderBody,
  UpdateServiceOrderBody,
} from "@workspace/api-zod";
import { effectiveServiceReminderRecipient } from "../lib/service-booking-contact";

// Keep this list in lockstep with the Add Service dialog. Every editable
// intake field must also be accepted by PATCH, including nullable clears.
const addServiceFields = [
  "customerId",
  "customerName",
  "customerPhoneSnapshot",
  "customerEmail",
  "vehicleInfo",
  "vin",
  "registrationNumber",
  "type",
  "scheduledDate",
  "complaint",
  "odometer",
  "estimatedCost",
  "estimatedHours",
  "technicianUserId",
] as const;
const createFields = Object.keys(CreateServiceOrderBody.shape);
const updateFields = Object.keys(UpdateServiceOrderBody.shape);

for (const field of addServiceFields) {
  assert.ok(createFields.includes(field), `${field} must be accepted by create`);
  assert.ok(updateFields.includes(field), `${field} must be accepted by edit`);
}

const clearedEdit = UpdateServiceOrderBody.safeParse({
  customerId: null,
  customerName: null,
  customerEmail: null,
  customerPhoneSnapshot: null,
  vehicleInfo: "2022 BMW X5",
  vin: null,
  registrationNumber: null,
  type: "maintenance",
  scheduledDate: "2026-09-24",
  complaint: null,
  odometer: null,
  estimatedCost: null,
  estimatedHours: null,
  technician: null,
  technicianUserId: null,
});
assert.equal(clearedEdit.success, true, "optional edit fields must support explicit clears");

assert.equal(effectiveServiceReminderRecipient(undefined), null);
assert.equal(effectiveServiceReminderRecipient(" \t\n "), null);
assert.equal(
  effectiveServiceReminderRecipient(" customer@example.com "),
  "customer@example.com",
);

console.log("Service booking contract: parity, clearing, and reminder guards passed");