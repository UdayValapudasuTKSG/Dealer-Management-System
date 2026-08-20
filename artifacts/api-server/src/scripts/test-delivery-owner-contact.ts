import assert from "node:assert/strict";
import { resolveDeliveryOwnerContact } from "../lib/delivery-owner-contact";

const leadOnly = resolveDeliveryOwnerContact(null, {
  name: "Lead Owner",
  email: "lead@example.com",
  phone: "+592 555 0100",
  address: "10 Main Street",
});
assert.deepEqual(leadOnly, {
  name: "Lead Owner",
  email: "lead@example.com",
  phone: "+592 555 0100",
  address: "10 Main Street",
});

const partialCustomer = resolveDeliveryOwnerContact(
  {
    name: "Customer Owner",
    email: " customer@example.com ",
    phone: " ",
    address: " 22 Customer Avenue ",
  },
  {
    name: "Lead Owner",
    email: "lead@example.com",
    phone: "+592 555 0100",
    address: "10 Main Street",
  },
);
assert.deepEqual(partialCustomer, {
  name: "Customer Owner",
  email: "customer@example.com",
  phone: "+592 555 0100",
  address: "22 Customer Avenue",
});

const localityFallback = resolveDeliveryOwnerContact(
  {
    location: "",
    city: "Georgetown",
    country: "Guyana",
  },
  { address: "Lead address must not win" },
);
assert.equal(localityFallback.address, "Georgetown, Guyana");

const emptyCustomerLocation = resolveDeliveryOwnerContact(
  {
    address: "",
    location: "",
    city: "",
    country: "",
  },
  { address: "Lead fallback address" },
);
assert.equal(emptyCustomerLocation.address, "Lead fallback address");

console.info("Delivery owner contact regression passed (4 cases).");