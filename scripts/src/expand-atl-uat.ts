// ATL Automotive UAT catalogue expansion (Task: Expand ATL models and parts).
//
// Purpose-built, narrower companion to seed-atl-uat.ts. The original seeder's
// tenant guard now (correctly) refuses to run because ATL has real UAT
// activity (SMTP connection, non-UAT-labelled leads/deals). This script:
//   - NEVER touches leads, deals, settings, or outbound channels;
//   - only ADDS/UPDATES vehicles whose VINs match its own stable synthetic
//     UATATL% range, via the real Excel preview→apply import flow;
//   - seeds a UAT parts catalogue (stable globally-unique UAT-ATL-% SKUs,
//     fictional suppliers, GYD pricing) through the real bulk parts importer,
//     but only after confirming NO enabled ERPNext connection exists for ATL.
//
// Model list is a snapshot of ATL's public inventory index
// (atlautomotive.com/inventory, pages 1-10, captured 2026-08-22): 85 distinct
// listings across Audi, BMW, BYD, Foton, Honda, Jaecoo, Kia, MG, MINI, Omoda,
// Porsche and Volkswagen. Only short factual make/model/spec references are
// used — no photos, real VINs/engine numbers, or exact commercial pricing.
// Prices are UAT demonstration values in GYD.
//
// Idempotent: VIN/engine assignment is a pure function of the model row and
// unit index; re-runs re-import only rows whose VIN is missing (matching VIN
// with blank Inventory ID updates in place, so no duplicates). Parts upsert
// by SKU.
//
// Run: pnpm --filter @workspace/scripts run expand-atl-uat
// Requires the api-server workflow running in dev (x-test-user-email honored).

import * as XLSX from "xlsx";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

const BASE = process.env.API_BASE ?? "http://localhost:80/api";
const SUPER_ADMIN =
  process.env.SUPER_ADMIN_EMAIL?.split(",")[0]?.trim() ??
  "uday.valapudasu@theksquaregroup.com";
const DEALER_NAME = "ATL Automotive";

let dealerId = 0;

async function api(
  method: string,
  path: string,
  opts: { body?: unknown; form?: FormData; dealer?: boolean } = {},
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {
    "x-test-user-email": SUPER_ADMIN,
  };
  if (opts.dealer) headers["x-dealer-id"] = String(dealerId);
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body:
      opts.form ??
      (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json };
}

function fail(step: string, r: { status: number; json: any }): never {
  console.error(`✗ ${step} failed (${r.status}):`, JSON.stringify(r.json));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Stable synthetic identities. The original seed used uatVin(1..12) /
// uatEngineNumber(1..12); this expansion allocates from 1000 upward so the
// two ranges can never collide. Index = 1000 + modelIdx*10 + unit, which is
// stable as long as new models are only APPENDED to MODELS below.
// ---------------------------------------------------------------------------
const uatVin = (n: number) => `UATATL${String(n).padStart(11, "0")}`;
const uatEngineNumber = (n: number) =>
  `UATATLENG${String(n).padStart(8, "0")}`;
const UNITS_PER_MODEL = 2;
const idFor = (modelIdx: number, unit: number) =>
  1000 + modelIdx * 10 + unit; // unit is 1-based

type Model = {
  make: string;
  model: string;
  trim?: string;
  year: number;
  price: number; // GYD, UAT demo value
  powertrain: "Petrol" | "Diesel" | "Hybrid" | "EV";
  bodyType: string;
  rangeKm?: number;
};

// Snapshot of every distinct listing on ATL's public inventory (2026-08-22).
// APPEND ONLY — reordering or inserting mid-list changes VIN assignment.
const MODELS: Model[] = [
  // Audi
  { make: "Audi", model: "A3", year: 2026, price: 14_500_000, powertrain: "Petrol", bodyType: "Sedan" },
  { make: "Audi", model: "S3", year: 2026, price: 21_000_000, powertrain: "Petrol", bodyType: "Sedan" },
  { make: "Audi", model: "A3", year: 2025, price: 13_800_000, powertrain: "Petrol", bodyType: "Sedan" },
  { make: "Audi", model: "A4", year: 2024, price: 16_500_000, powertrain: "Petrol", bodyType: "Sedan" },
  { make: "Audi", model: "A5", year: 2025, price: 19_500_000, powertrain: "Petrol", bodyType: "Coupe" },
  { make: "Audi", model: "Q2", year: 2023, price: 11_500_000, powertrain: "Petrol", bodyType: "SUV" },
  { make: "Audi", model: "Q5", year: 2025, price: 24_000_000, powertrain: "Petrol", bodyType: "SUV" },
  { make: "Audi", model: "Q5 Sportback", year: 2025, price: 25_500_000, powertrain: "Petrol", bodyType: "SUV" },
  { make: "Audi", model: "Q5 Sportback", year: 2024, price: 23_800_000, powertrain: "Petrol", bodyType: "SUV" },
  { make: "Audi", model: "Q6 e-tron", year: 2025, price: 33_000_000, powertrain: "EV", bodyType: "SUV", rangeKm: 520 },
  { make: "Audi", model: "Q6 Sportback e-tron", year: 2025, price: 34_500_000, powertrain: "EV", bodyType: "SUV", rangeKm: 545 },
  { make: "Audi", model: "Q7", year: 2025, price: 34_000_000, powertrain: "Petrol", bodyType: "SUV" },
  { make: "Audi", model: "Q8", year: 2025, price: 42_000_000, powertrain: "Petrol", bodyType: "SUV" },
  { make: "Audi", model: "Q8 e-tron", year: 2024, price: 38_500_000, powertrain: "EV", bodyType: "SUV", rangeKm: 500 },
  { make: "Audi", model: "Q8 e-tron", year: 2023, price: 34_500_000, powertrain: "EV", bodyType: "SUV", rangeKm: 490 },
  { make: "Audi", model: "Q8 Sportback e-tron", year: 2024, price: 40_000_000, powertrain: "EV", bodyType: "SUV", rangeKm: 505 },
  { make: "Audi", model: "RS e-tron GT", year: 2024, price: 62_000_000, powertrain: "EV", bodyType: "Sedan", rangeKm: 470 },
  // BMW
  { make: "BMW", model: "X1", trim: "sDrive18i", year: 2021, price: 12_500_000, powertrain: "Petrol", bodyType: "SUV" },
  { make: "BMW", model: "X3", year: 2021, price: 16_500_000, powertrain: "Petrol", bodyType: "SUV" },
  { make: "BMW", model: "X3", year: 2024, price: 24_500_000, powertrain: "Petrol", bodyType: "SUV" },
  { make: "BMW", model: "X5", year: 2022, price: 28_000_000, powertrain: "Petrol", bodyType: "SUV" },
  { make: "BMW", model: "X6", year: 2023, price: 34_000_000, powertrain: "Petrol", bodyType: "SUV" },
  { make: "BMW", model: "X6", year: 2024, price: 38_500_000, powertrain: "Petrol", bodyType: "SUV" },
  { make: "BMW", model: "X7", year: 2024, price: 46_000_000, powertrain: "Petrol", bodyType: "SUV" },
  // BYD
  { make: "BYD", model: "Atto 8", year: 2027, price: 21_500_000, powertrain: "Hybrid", bodyType: "SUV" },
  { make: "BYD", model: "Seal", trim: "AWD", year: 2027, price: 18_500_000, powertrain: "EV", bodyType: "Sedan", rangeKm: 520 },
  { make: "BYD", model: "Sealion 7", trim: "AWD", year: 2027, price: 20_500_000, powertrain: "EV", bodyType: "SUV", rangeKm: 502 },
  { make: "BYD", model: "Sealion 7", trim: "RWD", year: 2027, price: 18_800_000, powertrain: "EV", bodyType: "SUV", rangeKm: 482 },
  { make: "BYD", model: "Sealion 7", trim: "AWD", year: 2026, price: 19_800_000, powertrain: "EV", bodyType: "SUV", rangeKm: 502 },
  { make: "BYD", model: "Shark", year: 2026, price: 17_500_000, powertrain: "Hybrid", bodyType: "Pickup" },
  { make: "BYD", model: "Shark", year: 2027, price: 18_200_000, powertrain: "Hybrid", bodyType: "Pickup" },
  { make: "BYD", model: "Song Plus DM-i", year: 2027, price: 15_500_000, powertrain: "Hybrid", bodyType: "SUV" },
  { make: "BYD", model: "Song Pro DM-i", year: 2027, price: 13_800_000, powertrain: "Hybrid", bodyType: "SUV" },
  { make: "BYD", model: "Yuan Plus", year: 2027, price: 12_500_000, powertrain: "EV", bodyType: "SUV", rangeKm: 430 },
  { make: "BYD", model: "Yuan Pro", year: 2027, price: 10_800_000, powertrain: "EV", bodyType: "SUV", rangeKm: 380 },
  // Foton
  { make: "Foton", model: "Miler Box Truck", year: 2026, price: 9_800_000, powertrain: "Diesel", bodyType: "Truck" },
  { make: "Foton", model: "Miler Box Truck", trim: "Lift", year: 2026, price: 11_200_000, powertrain: "Diesel", bodyType: "Truck" },
  { make: "Foton", model: "Miler Flatbed Truck", year: 2026, price: 9_200_000, powertrain: "Diesel", bodyType: "Truck" },
  { make: "Foton", model: "Tunland G7", year: 2026, price: 8_800_000, powertrain: "Diesel", bodyType: "Pickup" },
  { make: "Foton", model: "Tunland V9", year: 2026, price: 10_500_000, powertrain: "Diesel", bodyType: "Pickup" },
  { make: "Foton", model: "View C2 Panel Van", year: 2026, price: 7_800_000, powertrain: "Diesel", bodyType: "Van" },
  { make: "Foton", model: "View CS2 Passenger Bus", year: 2026, price: 8_900_000, powertrain: "Diesel", bodyType: "Bus" },
  // Honda
  { make: "Honda", model: "BR-V", year: 2026, price: 9_500_000, powertrain: "Petrol", bodyType: "SUV" },
  { make: "Honda", model: "Civic Type R", year: 2023, price: 18_500_000, powertrain: "Petrol", bodyType: "Hatchback" },
  { make: "Honda", model: "CR-V", year: 2026, price: 15_800_000, powertrain: "Hybrid", bodyType: "SUV" },
  { make: "Honda", model: "Elevate", year: 2026, price: 8_900_000, powertrain: "Petrol", bodyType: "SUV" },
  { make: "Honda", model: "HR-V", year: 2026, price: 11_200_000, powertrain: "Petrol", bodyType: "SUV" },
  { make: "Honda", model: "Odyssey", year: 2024, price: 16_800_000, powertrain: "Petrol", bodyType: "Minivan" },
  { make: "Honda", model: "Pilot", year: 2023, price: 17_500_000, powertrain: "Petrol", bodyType: "SUV" },
  { make: "Honda", model: "Ridgeline", year: 2026, price: 16_200_000, powertrain: "Petrol", bodyType: "Pickup" },
  // Jaecoo
  { make: "Jaecoo", model: "J6", year: 2026, price: 9_800_000, powertrain: "EV", bodyType: "SUV", rangeKm: 400 },
  { make: "Jaecoo", model: "J7", trim: "Comfort", year: 2026, price: 10_200_000, powertrain: "Petrol", bodyType: "SUV" },
  { make: "Jaecoo", model: "J7", trim: "Luxury", year: 2026, price: 11_400_000, powertrain: "Petrol", bodyType: "SUV" },
  { make: "Jaecoo", model: "J7 PHEV", year: 2026, price: 13_200_000, powertrain: "Hybrid", bodyType: "SUV" },
  { make: "Jaecoo", model: "J8", year: 2026, price: 14_800_000, powertrain: "Petrol", bodyType: "SUV" },
  // Kia
  { make: "Kia", model: "Carens", year: 2024, price: 8_200_000, powertrain: "Petrol", bodyType: "MPV" },
  { make: "Kia", model: "Carnival", year: 2026, price: 15_500_000, powertrain: "Petrol", bodyType: "Minivan" },
  { make: "Kia", model: "EV5", year: 2025, price: 14_500_000, powertrain: "EV", bodyType: "SUV", rangeKm: 480 },
  { make: "Kia", model: "EV9", year: 2025, price: 26_500_000, powertrain: "EV", bodyType: "SUV", rangeKm: 505 },
  { make: "Kia", model: "K-Truck", year: 2025, price: 5_200_000, powertrain: "Petrol", bodyType: "Truck" },
  { make: "Kia", model: "K4", year: 2026, price: 9_200_000, powertrain: "Petrol", bodyType: "Sedan" },
  { make: "Kia", model: "Picanto", year: 2024, price: 5_800_000, powertrain: "Petrol", bodyType: "Hatchback" },
  { make: "Kia", model: "Seltos", year: 2026, price: 9_800_000, powertrain: "Petrol", bodyType: "SUV" },
  { make: "Kia", model: "Soluto", year: 2025, price: 6_400_000, powertrain: "Petrol", bodyType: "Sedan" },
  { make: "Kia", model: "Sonet", year: 2026, price: 7_800_000, powertrain: "Petrol", bodyType: "SUV" },
  { make: "Kia", model: "Sorento", year: 2026, price: 15_800_000, powertrain: "Petrol", bodyType: "SUV" },
  { make: "Kia", model: "Sportage", year: 2026, price: 12_800_000, powertrain: "Petrol", bodyType: "SUV" },
  { make: "Kia", model: "Tasman", year: 2026, price: 13_500_000, powertrain: "Diesel", bodyType: "Pickup" },
  // MG
  { make: "MG", model: "HS", year: 2026, price: 10_500_000, powertrain: "Petrol", bodyType: "SUV" },
  { make: "MG", model: "ZS", year: 2027, price: 8_200_000, powertrain: "Petrol", bodyType: "SUV" },
  // MINI
  { make: "MINI", model: "Countryman", trim: "JCW ALL4", year: 2024, price: 19_500_000, powertrain: "Petrol", bodyType: "SUV" },
  // Omoda
  { make: "Omoda", model: "C5", trim: "Comfort", year: 2026, price: 8_800_000, powertrain: "Petrol", bodyType: "SUV" },
  { make: "Omoda", model: "C5", trim: "Luxury", year: 2026, price: 9_900_000, powertrain: "Petrol", bodyType: "SUV" },
  { make: "Omoda", model: "C5 EV", year: 2026, price: 11_800_000, powertrain: "EV", bodyType: "SUV", rangeKm: 430 },
  // Porsche
  { make: "Porsche", model: "911 Carrera GTS", year: 2025, price: 88_000_000, powertrain: "Hybrid", bodyType: "Coupe" },
  { make: "Porsche", model: "Cayenne", year: 2023, price: 48_000_000, powertrain: "Petrol", bodyType: "SUV" },
  { make: "Porsche", model: "Cayenne E-Hybrid", year: 2024, price: 56_000_000, powertrain: "Hybrid", bodyType: "SUV" },
  { make: "Porsche", model: "Cayenne E-Hybrid Coupe", year: 2024, price: 59_000_000, powertrain: "Hybrid", bodyType: "SUV" },
  { make: "Porsche", model: "Macan", year: 2021, price: 26_000_000, powertrain: "Petrol", bodyType: "SUV" },
  { make: "Porsche", model: "Macan", year: 2025, price: 38_000_000, powertrain: "Petrol", bodyType: "SUV" },
  { make: "Porsche", model: "Macan 4 Electric", year: 2024, price: 44_000_000, powertrain: "EV", bodyType: "SUV", rangeKm: 510 },
  { make: "Porsche", model: "Taycan", year: 2025, price: 62_000_000, powertrain: "EV", bodyType: "Sedan", rangeKm: 590 },
  // Volkswagen
  { make: "Volkswagen", model: "Tiguan Allspace", trim: "4x4 Elegance", year: 2023, price: 14_200_000, powertrain: "Petrol", bodyType: "SUV" },
  { make: "Volkswagen", model: "Tiguan Allspace", trim: "4x4 Life", year: 2023, price: 13_200_000, powertrain: "Petrol", bodyType: "SUV" },
  { make: "Volkswagen", model: "Tiguan Allspace", trim: "4x4 R-Line", year: 2023, price: 15_400_000, powertrain: "Petrol", bodyType: "SUV" },
];

// Two units per model get distinct colours, cycled deterministically.
const COLORS = [
  "Glacier White", "Mythos Black", "Deep Blue Metallic", "Silver Metallic",
  "Graphite Grey", "Ruby Red", "Ocean Teal", "Sand Beige",
];
const colorFor = (modelIdx: number, unit: number) =>
  COLORS[(modelIdx + unit) % COLORS.length];

// ---------------------------------------------------------------------------
// UAT parts catalogue — fictional suppliers, GYD pricing, stable global SKUs.
// ---------------------------------------------------------------------------
type PartRow = {
  sku: string;
  name: string;
  category: string;
  supplier: string;
  unitCost: number; // GYD
  unitPrice: number; // GYD
  stock: number;
  reorderLevel: number;
  location: string;
};

const SUPPLIERS = {
  general: "UAT Parts Supply Co (fictional)",
  electrical: "UAT AutoElectric Distributors (fictional)",
  consumables: "UAT Lubes & Consumables Ltd (fictional)",
};

const PARTS: PartRow[] = [
  // Filters
  { sku: "UAT-ATL-FLT-001", name: "Engine Oil Filter — compact petrol (UAT)", category: "Filters", supplier: SUPPLIERS.general, unitCost: 3_500, unitPrice: 6_500, stock: 40, reorderLevel: 10, location: "A1-01" },
  { sku: "UAT-ATL-FLT-002", name: "Engine Oil Filter — SUV petrol/diesel (UAT)", category: "Filters", supplier: SUPPLIERS.general, unitCost: 5_200, unitPrice: 9_500, stock: 35, reorderLevel: 10, location: "A1-02" },
  { sku: "UAT-ATL-FLT-003", name: "Cabin Air Filter — standard (UAT)", category: "Filters", supplier: SUPPLIERS.general, unitCost: 4_000, unitPrice: 7_800, stock: 30, reorderLevel: 8, location: "A1-03" },
  { sku: "UAT-ATL-FLT-004", name: "Engine Air Filter — panel type (UAT)", category: "Filters", supplier: SUPPLIERS.general, unitCost: 4_800, unitPrice: 8_900, stock: 28, reorderLevel: 8, location: "A1-04" },
  { sku: "UAT-ATL-FLT-005", name: "Fuel Filter — diesel truck (UAT)", category: "Filters", supplier: SUPPLIERS.general, unitCost: 7_500, unitPrice: 13_500, stock: 18, reorderLevel: 6, location: "A1-05" },
  // Brakes
  { sku: "UAT-ATL-BRK-001", name: "Front Brake Pad Set — compact (UAT)", category: "Brakes", supplier: SUPPLIERS.general, unitCost: 14_000, unitPrice: 26_000, stock: 24, reorderLevel: 6, location: "B2-01" },
  { sku: "UAT-ATL-BRK-002", name: "Front Brake Pad Set — SUV (UAT)", category: "Brakes", supplier: SUPPLIERS.general, unitCost: 21_000, unitPrice: 38_500, stock: 20, reorderLevel: 6, location: "B2-02" },
  { sku: "UAT-ATL-BRK-003", name: "Rear Brake Pad Set — SUV (UAT)", category: "Brakes", supplier: SUPPLIERS.general, unitCost: 18_500, unitPrice: 34_000, stock: 20, reorderLevel: 6, location: "B2-03" },
  { sku: "UAT-ATL-BRK-004", name: "Front Brake Disc — ventilated 320mm (UAT)", category: "Brakes", supplier: SUPPLIERS.general, unitCost: 32_000, unitPrice: 58_000, stock: 12, reorderLevel: 4, location: "B2-04" },
  { sku: "UAT-ATL-BRK-005", name: "Brake Fluid DOT 4 — 1L (UAT)", category: "Brakes", supplier: SUPPLIERS.consumables, unitCost: 2_800, unitPrice: 5_200, stock: 48, reorderLevel: 12, location: "B2-05" },
  // Batteries
  { sku: "UAT-ATL-BAT-001", name: "12V Battery 55Ah — compact (UAT)", category: "Batteries", supplier: SUPPLIERS.electrical, unitCost: 38_000, unitPrice: 65_000, stock: 15, reorderLevel: 4, location: "C3-01" },
  { sku: "UAT-ATL-BAT-002", name: "12V Battery 75Ah AGM — start/stop (UAT)", category: "Batteries", supplier: SUPPLIERS.electrical, unitCost: 62_000, unitPrice: 105_000, stock: 10, reorderLevel: 3, location: "C3-02" },
  { sku: "UAT-ATL-BAT-003", name: "12V Auxiliary Battery — EV/hybrid (UAT)", category: "Batteries", supplier: SUPPLIERS.electrical, unitCost: 48_000, unitPrice: 84_000, stock: 8, reorderLevel: 3, location: "C3-03" },
  // Fluids
  { sku: "UAT-ATL-FLD-001", name: "Engine Oil 5W-30 Synthetic — 4L (UAT)", category: "Fluids", supplier: SUPPLIERS.consumables, unitCost: 8_500, unitPrice: 15_500, stock: 60, reorderLevel: 15, location: "D4-01" },
  { sku: "UAT-ATL-FLD-002", name: "Engine Oil 0W-20 Synthetic — 4L (UAT)", category: "Fluids", supplier: SUPPLIERS.consumables, unitCost: 9_200, unitPrice: 16_800, stock: 50, reorderLevel: 12, location: "D4-02" },
  { sku: "UAT-ATL-FLD-003", name: "Diesel Engine Oil 15W-40 — 5L (UAT)", category: "Fluids", supplier: SUPPLIERS.consumables, unitCost: 9_800, unitPrice: 17_500, stock: 30, reorderLevel: 8, location: "D4-03" },
  { sku: "UAT-ATL-FLD-004", name: "Coolant Concentrate — 4L (UAT)", category: "Fluids", supplier: SUPPLIERS.consumables, unitCost: 4_500, unitPrice: 8_500, stock: 40, reorderLevel: 10, location: "D4-04" },
  { sku: "UAT-ATL-FLD-005", name: "ATF Automatic Transmission Fluid — 4L (UAT)", category: "Fluids", supplier: SUPPLIERS.consumables, unitCost: 11_000, unitPrice: 19_500, stock: 22, reorderLevel: 6, location: "D4-05" },
  // Lamps
  { sku: "UAT-ATL-LMP-001", name: "Halogen Bulb H7 55W (UAT)", category: "Lamps", supplier: SUPPLIERS.electrical, unitCost: 1_200, unitPrice: 2_500, stock: 80, reorderLevel: 20, location: "E5-01" },
  { sku: "UAT-ATL-LMP-002", name: "LED Headlamp Bulb H4 kit (UAT)", category: "Lamps", supplier: SUPPLIERS.electrical, unitCost: 6_500, unitPrice: 12_000, stock: 25, reorderLevel: 8, location: "E5-02" },
  { sku: "UAT-ATL-LMP-003", name: "Tail Lamp Bulb P21/5W — pair (UAT)", category: "Lamps", supplier: SUPPLIERS.electrical, unitCost: 900, unitPrice: 1_900, stock: 90, reorderLevel: 24, location: "E5-03" },
  // Belts
  { sku: "UAT-ATL-BLT-001", name: "Serpentine Drive Belt — 6PK (UAT)", category: "Belts", supplier: SUPPLIERS.general, unitCost: 7_200, unitPrice: 13_500, stock: 16, reorderLevel: 5, location: "F6-01" },
  { sku: "UAT-ATL-BLT-002", name: "Timing Belt Kit with tensioner (UAT)", category: "Belts", supplier: SUPPLIERS.general, unitCost: 28_000, unitPrice: 49_500, stock: 8, reorderLevel: 3, location: "F6-02" },
  // Wipers
  { sku: "UAT-ATL-WPR-001", name: "Wiper Blade 24in — beam type (UAT)", category: "Wipers", supplier: SUPPLIERS.consumables, unitCost: 2_200, unitPrice: 4_500, stock: 45, reorderLevel: 12, location: "G7-01" },
  { sku: "UAT-ATL-WPR-002", name: "Wiper Blade 18in — beam type (UAT)", category: "Wipers", supplier: SUPPLIERS.consumables, unitCost: 1_900, unitPrice: 3_900, stock: 45, reorderLevel: 12, location: "G7-02" },
  { sku: "UAT-ATL-WPR-003", name: "Rear Wiper Blade 12in — SUV (UAT)", category: "Wipers", supplier: SUPPLIERS.consumables, unitCost: 1_700, unitPrice: 3_500, stock: 30, reorderLevel: 8, location: "G7-03" },
];

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

async function resolveDealer(): Promise<void> {
  const list = await api("GET", "/platform/dealers");
  if (list.status !== 200) fail("list dealers", list);
  const matches = (list.json as any[]).filter(
    (d) => d.name?.trim().toLowerCase() === DEALER_NAME.toLowerCase(),
  );
  if (matches.length !== 1) {
    console.error(
      `✗ expected exactly one dealer named "${DEALER_NAME}", found ${matches.length} — refusing to run`,
    );
    process.exit(1);
  }
  if (matches[0].status !== "active") {
    console.error(
      `✗ dealer #${matches[0].id} has status "${matches[0].status}" — refusing to run`,
    );
    process.exit(1);
  }
  dealerId = matches[0].id;
  console.log(`✓ dealer resolved: #${dealerId} (${matches[0].status})`);
}

/**
 * Narrow tenant guard for the expansion. Unlike seed-atl-uat's guard, this
 * intentionally tolerates SMTP config and real UAT lead/deal activity —
 * this script never touches those. It only demands that:
 *  - every vehicle VIN in this dealer sits in our synthetic UATATL% space
 *    (so we know the inventory is ours to extend), and
 *  - no expansion-range VIN exists in ANY OTHER dealer (cross-tenant VIN
 *    collision would corrupt matching-update semantics).
 */
async function assertVehicleSpaceOwned(): Promise<void> {
  const r = await db.execute(sql`select
    (select count(*)::int from vehicles where dealer_id = ${dealerId}
       and (vin is null or vin not like 'UATATL%')) as foreign_vehicles,
    (select count(*)::int from vehicles where dealer_id <> ${dealerId}
       and vin like 'UATATL%') as leaked_vins`);
  const c = r.rows[0] as any;
  if (c.foreign_vehicles > 0) {
    console.error(
      `✗ dealer #${dealerId} has ${c.foreign_vehicles} vehicle(s) outside the UATATL% VIN space — refusing to import`,
    );
    process.exit(1);
  }
  if (c.leaked_vins > 0) {
    console.error(
      `✗ found ${c.leaked_vins} UATATL% VIN(s) in other dealers — refusing to import`,
    );
    process.exit(1);
  }
  console.log("✓ vehicle identity space verified as ATL-UAT-owned");
}

/** Parts import enqueues ERPNext sync jobs; only proceed when no enabled
 *  ERPNext connection exists for ATL, so nothing can reach an external ERP. */
async function assertNoEnabledErpnext(): Promise<boolean> {
  const r = await db.execute(sql`select count(*)::int as enabled
    from erpnext_connections where dealer_id = ${dealerId} and enabled = true`);
  const enabled = (r.rows[0] as any).enabled as number;
  if (enabled > 0) {
    console.error(
      `✗ dealer #${dealerId} has an ENABLED ERPNext connection — skipping parts import (vehicle import unaffected)`,
    );
    return false;
  }
  console.log("✓ no enabled ERPNext connection — parts import is UAT-safe");
  return true;
}

async function startImpersonation(): Promise<void> {
  const grant = await api("POST", "/platform/impersonation", {
    body: {
      dealerId,
      reason: "Expand ATL Automotive UAT catalogue (vehicles + parts)",
      mode: "elevated",
    },
  });
  if (grant.status !== 200 && grant.status !== 201)
    fail("start impersonation", grant);
  console.log("✓ elevated impersonation window opened");
}

// ---------------------------------------------------------------------------
// Vehicle import (Excel preview → apply)
// ---------------------------------------------------------------------------

const IMPORT_HEADERS = [
  "Make", "Model", "Trim", "Year", "VIN", "Engine Number", "Price", "Powertrain",
  "Mileage km", "Exterior Color", "Body Type", "Transmission",
  "Range km", "Description",
];

type Unit = { m: Model; modelIdx: number; unit: number };

function buildWorkbook(units: Unit[]): Buffer {
  const data: (string | number)[][] = [IMPORT_HEADERS];
  for (const { m, modelIdx, unit } of units) {
    const id = idFor(modelIdx, unit);
    data.push([
      m.make, m.model, m.trim ?? "", m.year, uatVin(id), uatEngineNumber(id),
      m.price, m.powertrain, 0, colorFor(modelIdx, unit), m.bodyType,
      "Automatic", m.rangeKm ?? "",
      "UAT sample — publicly listed ATL model (catalogue expansion)",
    ]);
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(data), "Vehicles");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

async function importVehicles(): Promise<void> {
  const existing = await api("GET", "/vehicles", { dealer: true });
  if (existing.status !== 200) fail("list vehicles", existing);
  const existingByVin = new Map(
    (existing.json as any[]).map((v) => [(v.vin ?? "").toUpperCase(), v]),
  );

  const pending: Unit[] = [];
  const conflicts: string[] = [];
  MODELS.forEach((m, modelIdx) => {
    for (let unit = 1; unit <= UNITS_PER_MODEL; unit++) {
      const id = idFor(modelIdx, unit);
      const current = existingByVin.get(uatVin(id));
      if (!current) {
        pending.push({ m, modelIdx, unit });
        continue;
      }
      // Fail closed if a record already holding one of our expansion VINs
      // does not look like the exact vehicle this script created. A VIN
      // match with different identity means the record was repurposed —
      // re-importing would overwrite it with the full workbook row.
      if (
        current.make !== m.make ||
        current.model !== m.model ||
        current.year !== m.year
      ) {
        conflicts.push(
          `${uatVin(id)}: expected ${m.year} ${m.make} ${m.model}, found ${current.year} ${current.make} ${current.model}`,
        );
        continue;
      }
      if (current.engineNumber?.trim()?.toUpperCase() !== uatEngineNumber(id))
        pending.push({ m, modelIdx, unit });
    }
  });
  if (conflicts.length > 0) {
    console.error(
      `✗ ${conflicts.length} expansion VIN(s) are held by repurposed records — refusing to import:\n  - ${conflicts.join("\n  - ")}`,
    );
    process.exit(1);
  }
  const total = MODELS.length * UNITS_PER_MODEL;
  if (pending.length === 0) {
    console.log(`✓ all ${total} expansion vehicles already imported`);
    return;
  }

  const buf = buildWorkbook(pending);
  const makeForm = () => {
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(buf)], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
      "atl-uat-expansion.xlsx",
    );
    return form;
  };

  const preview = await api("POST", "/vehicles/import?mode=preview", {
    form: makeForm(),
    dealer: true,
  });
  if (preview.status !== 200) fail("import preview", preview);
  const pv = preview.json;
  const previewErrors =
    pv.errors ?? pv.rows?.filter((r: any) => r.errors?.length) ?? [];
  if (Array.isArray(previewErrors) && previewErrors.length > 0) {
    console.error(
      "✗ import preview reported row errors:",
      JSON.stringify(previewErrors, null, 2),
    );
    process.exit(1);
  }
  console.log(`✓ import preview clean (${pending.length} of ${total} rows pending)`);

  const apply = await api("POST", "/vehicles/import?mode=apply", {
    form: makeForm(),
    dealer: true,
  });
  if (apply.status !== 200 && apply.status !== 201) fail("import apply", apply);
  console.log(`✓ import applied: ${JSON.stringify(apply.json?.summary ?? apply.json)}`);
}

// ---------------------------------------------------------------------------
// Parts import (CSV upsert by SKU)
// ---------------------------------------------------------------------------

function buildPartsCsv(): string {
  const esc = (s: string | number) => {
    const t = String(s);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const lines = [
    "Part Number,Description,Category,Supplier,Unit Cost,Sell Price,Stock,Reorder Level,Location",
  ];
  for (const p of PARTS)
    lines.push(
      [p.sku, p.name, p.category, p.supplier, p.unitCost, p.unitPrice, p.stock, p.reorderLevel, p.location]
        .map(esc)
        .join(","),
    );
  return lines.join("\n");
}

async function importParts(): Promise<void> {
  // parts.sku is GLOBALLY unique — refuse if any of our SKUs already exists
  // in another dealer (would silently be a different tenant's part).
  const skus = PARTS.map((p) => p.sku);
  const clash = await db.execute(sql`select sku from parts
    where dealer_id <> ${dealerId}
      and sku in (${sql.join(skus.map((s) => sql`${s}`), sql`, `)})`);
  if (clash.rows.length > 0) {
    console.error(
      `✗ SKU collision in other dealer(s): ${clash.rows.map((r: any) => r.sku).join(", ")} — refusing parts import`,
    );
    process.exit(1);
  }

  const form = new FormData();
  form.append(
    "file",
    new Blob([buildPartsCsv()], { type: "text/csv" }),
    "atl-uat-parts.csv",
  );
  const r = await api("POST", "/parts/import", { form, dealer: true });
  if (r.status !== 200 && r.status !== 201) fail("parts import", r);
  const summary = r.json?.summary ?? r.json ?? {};
  const rowErrors = summary.errors ?? r.json?.errors ?? [];
  if (Array.isArray(rowErrors) && rowErrors.length > 0) {
    console.error(
      "✗ parts import reported row errors:",
      JSON.stringify(rowErrors, null, 2),
    );
    process.exit(1);
  }
  console.log(`✓ parts import: ${JSON.stringify(summary)}`);

  await suppressUatErpJobs();
}

/**
 * The bulk parts importer unconditionally enqueues ERPNext part/supplier sync
 * jobs. ATL has no enabled ERPNext connection, so they only park — but parked
 * jobs would dispatch if a connection were ever enabled later, leaking the
 * synthetic UAT catalogue to a real ERP. Dead-letter exactly the jobs that
 * reference OUR UAT parts/suppliers (the queue only claims queued/failed).
 */
async function suppressUatErpJobs(): Promise<void> {
  const skus = PARTS.map((p) => p.sku);
  const supplierNames = Object.values(SUPPLIERS);
  // The importer enqueues sync jobs fire-and-forget, so a job can (re)appear
  // as queued moments after the HTTP response. Sweep repeatedly until a full
  // pass finds nothing left to suppress.
  let total = 0;
  for (let pass = 1; pass <= 10; pass++) {
    const n = await suppressPass(skus, supplierNames);
    total += n;
    if (n === 0 && pass > 1) break;
    await new Promise((res) => setTimeout(res, 1000));
  }
  console.log(
    `✓ suppressed ${total} parked ERPNext sync job(s) for UAT parts/suppliers`,
  );
}

async function suppressPass(
  skus: string[],
  supplierNames: string[],
): Promise<number> {
  const r = await db.execute(sql`update erpnext_sync_jobs j
    set status = 'dead',
        last_error = 'suppressed: synthetic ATL UAT catalogue — never deliver to ERP',
        updated_at = now()
    where j.dealer_id = ${dealerId}
      and j.status in ('queued', 'failed', 'processing')
      and (
        (j.entity_type = 'part' and j.entity_id in
          (select id from parts where dealer_id = ${dealerId}
             and sku in (${sql.join(skus.map((s) => sql`${s}`), sql`, `)})))
        or
        (j.entity_type = 'supplier' and j.entity_id in
          (select id from suppliers where dealer_id = ${dealerId}
             and name in (${sql.join(supplierNames.map((n) => sql`${n}`), sql`, `)})))
      )`);
  return r.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

async function verify(): Promise<void> {
  const r = await db.execute(sql`select
    (select count(*)::int from vehicles where dealer_id = ${dealerId}) as vehicles,
    (select count(distinct make || '|' || model)::int from vehicles where dealer_id = ${dealerId}) as models,
    (select count(*)::int from vehicles where dealer_id = ${dealerId}
       and (vin is null or length(vin) <> 17 or engine_number is null or length(engine_number) <> 17)) as bad_identity,
    (select count(*)::int from (select vin from vehicles where dealer_id = ${dealerId} group by vin having count(*) > 1) d) as dup_vins,
    (select count(*)::int from parts where dealer_id = ${dealerId}) as parts,
    (select count(distinct category)::int from parts where dealer_id = ${dealerId}) as part_categories,
    (select count(*)::int from suppliers where dealer_id = ${dealerId}) as suppliers,
    (select count(*)::int from vehicles where dealer_id <> ${dealerId} and vin like 'UATATL%') as leaked_vehicles,
    (select count(*)::int from parts where dealer_id <> ${dealerId} and sku like 'UAT-ATL-%') as leaked_parts`);
  const c = r.rows[0] as any;
  console.log(
    `\nATL Automotive UAT (#${dealerId}): ${c.vehicles} vehicles across ${c.models} make/model combos, ` +
      `${c.parts} parts in ${c.part_categories} categories, ${c.suppliers} suppliers`,
  );
  const errs: string[] = [];
  if (c.bad_identity > 0) errs.push(`${c.bad_identity} vehicle(s) with invalid VIN/engine identity`);
  if (c.dup_vins > 0) errs.push(`${c.dup_vins} duplicate VIN group(s)`);
  if (c.leaked_vehicles > 0) errs.push(`${c.leaked_vehicles} UAT vehicle(s) leaked to other dealers`);
  if (c.leaked_parts > 0) errs.push(`${c.leaked_parts} UAT part(s) leaked to other dealers`);
  if (errs.length > 0) {
    console.error(`✗ verification failed:\n  - ${errs.join("\n  - ")}`);
    process.exit(1);
  }
  console.log("✓ identities valid, no duplicates, all records scoped to ATL");

  // Exact expansion assertions: every expected VIN maps to its exact engine
  // number, make and model; every expected SKU exists ATL-scoped.
  const vrows = await db.execute(sql`select vin, engine_number, make, model, year
    from vehicles where dealer_id = ${dealerId} and vin like 'UATATL%'`);
  const byVin = new Map(
    (vrows.rows as any[]).map((v) => [v.vin as string, v]),
  );
  const vinErrs: string[] = [];
  MODELS.forEach((m, modelIdx) => {
    for (let unit = 1; unit <= UNITS_PER_MODEL; unit++) {
      const id = idFor(modelIdx, unit);
      const v = byVin.get(uatVin(id));
      if (!v) vinErrs.push(`${uatVin(id)} missing`);
      else if (
        v.engine_number !== uatEngineNumber(id) ||
        v.make !== m.make ||
        v.model !== m.model ||
        Number(v.year) !== m.year
      )
        vinErrs.push(
          `${uatVin(id)}: expected ${m.year} ${m.make} ${m.model} / ${uatEngineNumber(id)}, found ${v.year} ${v.make} ${v.model} / ${v.engine_number}`,
        );
    }
  });
  if (vinErrs.length > 0) {
    console.error(
      `✗ ${vinErrs.length} expansion vehicle(s) missing or mismatched:\n  - ${vinErrs.slice(0, 10).join("\n  - ")}`,
    );
    process.exit(1);
  }
  console.log(
    `✓ all ${MODELS.length * UNITS_PER_MODEL} expansion VINs map to their exact synthetic identities`,
  );

  const skus = PARTS.map((p) => p.sku);
  const prows = await db.execute(sql`select sku from parts
    where dealer_id = ${dealerId}
      and sku in (${sql.join(skus.map((s) => sql`${s}`), sql`, `)})`);
  const found = new Set((prows.rows as any[]).map((p) => p.sku as string));
  const missing = skus.filter((s) => !found.has(s));
  if (missing.length > 0) {
    console.error(`✗ ${missing.length} UAT SKU(s) missing: ${missing.join(", ")}`);
    process.exit(1);
  }
  console.log(`✓ all ${skus.length} UAT part SKUs present and ATL-scoped`);

  const parked = await db.execute(sql`select count(*)::int as n
    from erpnext_sync_jobs where dealer_id = ${dealerId}
      and status in ('queued', 'failed', 'processing')
      and entity_type in ('part', 'supplier')`);
  const n = (parked.rows[0] as any).n as number;
  if (n > 0) {
    console.error(`✗ ${n} part/supplier ERPNext sync job(s) still dispatchable`);
    process.exit(1);
  }
  console.log("✓ no dispatchable ERPNext part/supplier jobs remain for ATL");
}

async function main() {
  await resolveDealer();
  await assertVehicleSpaceOwned();
  const partsSafe = await assertNoEnabledErpnext();
  await startImpersonation();
  await importVehicles();
  if (partsSafe) await importParts();
  await verify();
  console.log("\nDone — ATL Automotive UAT catalogue expanded.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
