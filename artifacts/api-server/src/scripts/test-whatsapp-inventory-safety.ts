import assert from "node:assert/strict";
import {
  buildSystemPrompt,
  redactAssistantStockCounts,
  summarizeAvailableInventory,
} from "../lib/whatsapp-agent";
import { buildBrandRowsFromVehicles } from "../lib/whatsapp-flow";

type Inventory = Parameters<typeof summarizeAvailableInventory>[0];

const vehicle = (overrides: Partial<Inventory[number]>): Inventory[number] =>
  ({
    id: 1,
    dealerId: 7,
    divisionId: null,
    make: "BYD",
    model: "Shark",
    trim: "Premium",
    year: 2025,
    vin: null,
    engineNumber: null,
    registration: null,
    variant: null,
    engine: "1.5L",
    transmission: "Automatic",
    price: 15_000_000,
    dutyFreeAmount: 0,
    powertrain: "PHEV",
    rangeKm: 100,
    mileageKm: 0,
    exteriorColor: "Floating Sun Orange",
    bodyType: "Pickup",
    status: "available",
    holdUntil: null,
    holdReason: null,
    recallFlag: false,
    damageFlag: false,
    imageUrl: null,
    images: [],
    accessories: [],
    documents: [],
    importMetadata: null,
    description: null,
    featured: false,
    deletedAt: null,
    deletedBy: null,
    createdAt: new Date(0),
    ...overrides,
  }) as Inventory[number];

const inventory: Inventory = [
  vehicle({ id: 1 }),
  vehicle({ id: 2 }),
  vehicle({ id: 3, exteriorColor: "Black" }),
  vehicle({ id: 4, make: "Toyota", model: "RAV4", exteriorColor: "Black" }),
];

const shark = summarizeAvailableInventory(inventory, "BYD Shark", null);
const serialized = JSON.stringify(shark);
assert.equal(shark.availability, "available");
assert.equal(shark.models.length, 1);
assert.deepEqual(shark.models[0]?.colors, ["Black", "Floating Sun Orange"]);
assert.equal(shark.models[0]?.representative_vehicle_id, 1);
assert.equal(shark.models[0]?.price_gyd, 15_000_000);
assert.equal(shark.models[0]?.powertrain, "PHEV");
const keys: string[] = [];
JSON.parse(serialized, (key, value) => {
  if (key) keys.push(key);
  return value;
});
assert.equal(keys.some((key) => /available_count|model_count|quantity/i.test(key)), false);
assert.equal(Object.hasOwn(shark.models[0] ?? {}, "quantity"), false);

const absent = summarizeAvailableInventory(inventory, "Honda", null);
assert.equal(absent.availability, "no_match");
assert.deepEqual(absent.models, []);

const prompt = buildSystemPrompt(
  "AURA Motors",
  { summary: "A previous assistant said all 48 units, including both orange ones, are here." },
  false,
);
assert.match(prompt, /NEVER disclose, guess, calculate, confirm, or repeat/i);
assert.match(prompt, /previous assistant message/i);
assert.match(prompt, /does NOT prove a vehicle is physically/i);
assert.doesNotMatch(prompt, /\b48\b|both the orange/i);
assert.doesNotMatch(
  redactAssistantStockCounts(
    "All 48 BYD Shark units, including both the orange ones, are here. Price is 15000000.",
  ),
  /\b48\b|\bboth\b/i,
);

const rows = buildBrandRowsFromVehicles([
  { make: "BYD" },
  { make: "BYD" },
  { make: "Toyota" },
]);
assert.deepEqual(
  rows.map((row) => ({ title: row.title, description: row.description })),
  [
    { title: "BYD", description: "Currently available" },
    { title: "Toyota", description: "Currently available" },
  ],
);
assert.doesNotMatch(JSON.stringify(rows), /\b\d+\s+(?:in stock|units?)\b/i);

console.log("whatsapp inventory safety tests passed");