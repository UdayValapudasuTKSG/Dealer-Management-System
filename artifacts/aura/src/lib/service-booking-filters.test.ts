import assert from "node:assert/strict";
import test from "node:test";
import type { ServiceOrder } from "@workspace/api-client-react";
import {
  emptyServiceBookingFilters,
  filterServiceBookings,
  hasServiceBookingFilters,
} from "./service-booking-filters.ts";

function booking(overrides: Partial<ServiceOrder> = {}): ServiceOrder {
  return {
    id: 42,
    customerName: "Avery Singh",
    customerPhoneSnapshot: "+592 (600) 1234",
    customerEmail: "avery@example.com",
    vehicleInfo: "2021 Toyota Hilux",
    vin: "JT123ABC",
    registrationNumber: "GTT 2042",
    type: "repair",
    status: "open",
    scheduledDate: "2026-05-20",
    complaint: "Brake vibration",
    technician: "Jordan Lee",
    estimatedCost: 100,
    jobs: ["Inspect front rotors"],
    createdAt: "2026-05-01T12:00:00Z",
    ...overrides,
  };
}

test("searches all booking identity and contact fields without case or phone punctuation", () => {
  const orders = [booking()];
  for (const search of [
    "ro 00042",
    "AVERY",
    "avery@example",
    "5926001234",
    "toyota",
    "jt123abc",
    "gtt2042",
    "vibration",
    "front rotors",
    "jordan",
  ]) {
    assert.equal(
      filterServiceBookings(orders, { ...emptyServiceBookingFilters, search }).length,
      1,
      search,
    );
  }
});

test("combines search, status, and service type filters", () => {
  const orders = [
    booking(),
    booking({ id: 43, customerName: "Avery Persaud", status: "closed" }),
    booking({ id: 44, customerName: "Avery Khan", type: "maintenance" }),
  ];
  assert.deepEqual(
    filterServiceBookings(orders, {
      search: "avery",
      status: "open",
      serviceType: "repair",
    }).map(({ id }) => id),
    [42],
  );
});

test("empty filter state clears every client-side criterion", () => {
  assert.equal(hasServiceBookingFilters(emptyServiceBookingFilters), false);
  assert.equal(
    hasServiceBookingFilters({ search: "customer", status: "all", serviceType: "all" }),
    true,
  );
  assert.equal(filterServiceBookings([booking()], emptyServiceBookingFilters).length, 1);
});