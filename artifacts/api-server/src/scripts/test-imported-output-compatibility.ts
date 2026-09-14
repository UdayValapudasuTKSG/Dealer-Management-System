import assert from "node:assert/strict";
import {
  CreateLeadResponse,
  CreateVehicleBody,
  CreateVehicleResponse,
  GetLeadResponse,
  GetCustomerPersonaResponse,
  GetVehicleResponse,
  ListLeadsResponse,
  ListVehiclesResponse,
  RecommendCustomerVehicleResponse,
  RestoreVehicleResponse,
  UpdateLeadResponse,
  UpdateVehicleResponse,
} from "@workspace/api-zod";
import { matchesReviewedVehicle } from "../lib/reviewed-delivery-import-policy";
import {
  canonicalizeVehiclePowertrain,
  normalizePowertrain,
  normalizeVehiclePowertrainInput,
} from "../lib/vehicle-compat";

const createdAt = new Date("2026-09-24T12:00:00.000Z");

const importedVehicle = {
  id: 42,
  divisionId: null,
  make: "BYD",
  model: "SEALION 7",
  trim: "Premium",
  year: 2026,
  vin: "LVSFXXXXXXXXXXXXX",
  engineNumber: "ENGXXXXXXXXXXXXXXXX",
  registration: null,
  variant: null,
  engine: null,
  transmission: "Automatic",
  price: 18_500_000,
  dutyFreeAmount: 0,
  powertrain: "electric",
  rangeKm: 500,
  mileageKm: 0,
  exteriorColor: "Black",
  bodyType: "SUV",
  status: "booked",
  holdUntil: null,
  holdReason: null,
  recallFlag: false,
  damageFlag: false,
  imageUrl: null,
  images: [],
  accessories: [],
  documents: [],
  description: "Reviewed historical delivery",
  featured: false,
  createdAt,
  // This is intentionally unknown to the public response contract.  The
  // serializer must preserve the row's facts while emitting its canonical
  // powertrain for schema validation.
  importMetadata: {
    batchKey: "gt-automotive-august-2026-reviewed",
    reviewedVehicleFields: {
      make: "BYD",
      modelYear: 2026,
      powertrain: "electric",
      bodyType: "SUV",
    },
  },
};

const importedLead = {
  id: 84,
  divisionId: null,
  name: "Historical Customer",
  email: "historical@example.test",
  phone: "5926001234",
  channel: "reviewed_delivery_import",
  source: "walk_in",
  sourceDetail: null,
  priority: "medium",
  phase: "won",
  status: "converted",
  customerId: 12,
  interestedVehicleId: null,
  vehicleInterests: [
    {
      vehicleId: null,
      make: "BYD",
      model: "SEALION 7",
      modelYear: 2026,
      variant: "Premium",
      color: "Black",
      unitPrice: 18_500_000,
      quantity: 1,
      position: 0,
    },
  ],
  selectedModel: "SEALION 7",
  interestedModelText: "SEALION 7",
  variant: "Premium",
  color: "Black",
  preferredBranch: null,
  assignedTo: "Historical Advisor",
  ownerUserId: 9,
  testDriveAt: null,
  testDriveBranch: null,
  availability: null,
  purchaseType: "cash",
  attachments: [],
  aiScore: 50,
  notes: "Imported reviewed committed sale",
  company: null,
  title: null,
  isRetailCustomer: true,
  quotationSent: false,
  emailOptOut: false,
  reservationFeePaid: false,
  reservationComments: null,
  financingQualified: false,
  contactedDate: null,
  revisitIn3Months: false,
  closureReason: null,
  purchaseIntent: null,
  keyInterestDriver: null,
  budgetFinancing: null,
  description: null,
  address: null,
  stageEnteredAt: createdAt,
  testDriveLicence: null,
  testDriveWaiver: false,
  createdAt,
  importMetadata: {
    batchKey: "gt-automotive-august-2026-reviewed",
    suppressSalesAutomation: true,
  },
};

const canonicalVehicle = canonicalizeVehiclePowertrain(importedVehicle);
assert.equal(importedVehicle.powertrain, "electric");
assert.equal(canonicalVehicle.powertrain, "EV");
assert.throws(() => ListVehiclesResponse.parse([importedVehicle]));
assert.equal(normalizePowertrain(" electric "), "EV");
assert.equal(normalizePowertrain("Diesel"), "Diesel");

// The actual request schema remains canonical, while the server intake
// compatibility layer accepts the historical spelling and turns it into EV.
const inputWithLegacyPowertrain = normalizeVehiclePowertrainInput({
  make: "BYD",
  model: "SEALION 7",
  year: 2026,
  price: 18_500_000,
  powertrain: "electric",
  mileageKm: 0,
  exteriorColor: "Black",
  bodyType: "SUV",
});
assert.equal(inputWithLegacyPowertrain.powertrain, "EV");
assert.equal(CreateVehicleBody.safeParse(inputWithLegacyPowertrain).success, true);

// Every vehicle response shape that is serialized from a vehicle row must
// parse after canonicalization, including detail and lifecycle responses.
for (const schema of [
  ListVehiclesResponse,
  GetVehicleResponse,
  CreateVehicleResponse,
  UpdateVehicleResponse,
  RestoreVehicleResponse,
] as const) {
  const payload = schema === ListVehiclesResponse
    ? [canonicalVehicle]
    : canonicalVehicle;
  assert.doesNotThrow(() => schema.parse(payload));
}

const personaWithImportedVehicle = {
  id: 7,
  customerId: importedLead.customerId,
  aiRecommendedVehicleId: importedVehicle.id,
  aiRecommendationReason: "Matches the reviewed customer preference",
  aiRecommendedVehicle: canonicalVehicle,
  leadScore: 75,
  updatedAt: createdAt.toISOString(),
};
assert.throws(() =>
  GetCustomerPersonaResponse.parse({
    ...personaWithImportedVehicle,
    aiRecommendedVehicle: importedVehicle,
  }),
);
assert.doesNotThrow(() =>
  GetCustomerPersonaResponse.parse(personaWithImportedVehicle),
);
assert.doesNotThrow(() =>
  RecommendCustomerVehicleResponse.parse(personaWithImportedVehicle),
);

// Reviewed imports compare against the original row facts.  "electric" in an
// already-imported vehicle and EV in the canonical review input are the same
// powertrain, so replay matching does not create a duplicate.
assert.equal(
  matchesReviewedVehicle(
    importedVehicle,
    {
      sellingPrice: importedVehicle.price,
      raw: {
        Model: importedVehicle.model,
        Version: importedVehicle.trim ?? "",
        "Engine No": importedVehicle.engineNumber ?? "",
        Exterior: importedVehicle.exteriorColor,
      },
    },
    {
      modelYear: importedVehicle.year,
      vehicleMake: importedVehicle.make,
      powertrain: "EV",
      bodyType: importedVehicle.bodyType,
    },
  ),
  true,
);

// Imported provenance channel and the other imported lead fields must parse in
// both list and detail response schemas; no fallback to walkin is allowed.
assert.equal(importedLead.channel, "reviewed_delivery_import");
assert.doesNotThrow(() => ListLeadsResponse.parse([importedLead]));
assert.doesNotThrow(() => GetLeadResponse.parse(importedLead));
assert.doesNotThrow(() =>
  CreateLeadResponse.parse({
    lead: importedLead,
    merged: false,
    mergeNotice: null,
  }),
);
assert.doesNotThrow(() => UpdateLeadResponse.parse(importedLead));

console.log("Imported output compatibility checks passed.");
