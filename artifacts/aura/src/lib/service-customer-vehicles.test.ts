import assert from "node:assert/strict";
import test from "node:test";
import type { ServiceCustomerVehicle } from "@workspace/api-client-react";
import {
  isCurrentServiceVehicleLookup,
  matchServiceCustomerVehicle,
  selectServiceCustomerVehicle,
  serviceVehicleFields,
  shouldAutofillServiceVehicleField,
} from "./service-customer-vehicles";

function vehicle(
  overrides: Partial<ServiceCustomerVehicle> = {},
): ServiceCustomerVehicle {
  return {
    vehicleId: 1,
    assetId: 10,
    label: "2022 BMW X5",
    make: "BMW",
    model: "X5",
    year: 2022,
    trim: null,
    vin: "WBA12345678901234",
    registration: "PAB1234",
    status: "active",
    ...overrides,
  };
}

test("single canonical vehicle supplies all booking identity fields", () => {
  const saved = vehicle();
  const selected = selectServiceCustomerVehicle([saved], {
    vin: "",
    registrationNumber: "",
  });
  assert.equal(selected, saved);
  assert.deepEqual(serviceVehicleFields(saved), {
    vehicleInfo: "2022 BMW X5",
    vin: "WBA12345678901234",
    registrationNumber: "PAB1234",
  });
});

test("multiple vehicles never chooses one without a saved identity match", () => {
  const vehicles = [vehicle(), vehicle({ vehicleId: 2, vin: "WBA22345678901234" })];
  assert.equal(
    matchServiceCustomerVehicle(vehicles, {
      vin: "",
      registrationNumber: "",
    }),
    null,
  );
});

test("no vehicles leaves the identity unselected", () => {
  assert.equal(
    matchServiceCustomerVehicle([], { vin: "", registrationNumber: "" }),
    null,
  );
  assert.equal(
    matchServiceCustomerVehicle(undefined, { vin: "", registrationNumber: "" }),
    null,
  );
});

test("saved VIN or registration selects the matching vehicle", () => {
  const first = vehicle();
  const second = vehicle({
    vehicleId: 2,
    vin: "JH4TB2H26CC000002",
    registration: "PAB5678",
  });
  assert.equal(
    matchServiceCustomerVehicle([first, second], {
      vin: " jh4tb2h26cc000002 ",
      registrationNumber: "",
    }),
    second,
  );
  assert.equal(
    matchServiceCustomerVehicle([first, second], {
      vin: "",
      registrationNumber: "PAB 1234",
    }),
    first,
  );
});

test("manual edits and stale/closed responses are not eligible for autofill", () => {
  assert.equal(shouldAutofillServiceVehicleField(new Set(["vin"]), "vin"), false);
  assert.equal(shouldAutofillServiceVehicleField(new Set(["vin"]), "vehicleInfo"), true);
  assert.equal(
    isCurrentServiceVehicleLookup({
      dialogOpen: true,
      activeCustomerId: 22,
      responseCustomerId: 21,
    }),
    false,
  );
  assert.equal(
    isCurrentServiceVehicleLookup({
      dialogOpen: false,
      activeCustomerId: 22,
      responseCustomerId: 22,
    }),
    false,
  );
  assert.equal(
    isCurrentServiceVehicleLookup({
      dialogOpen: true,
      activeCustomerId: 22,
      responseCustomerId: 22,
    }),
    true,
  );
});
