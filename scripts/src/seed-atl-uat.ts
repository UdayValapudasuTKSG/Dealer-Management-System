// ATL Automotive UAT onboarding seeder (Task: Set up ATL Automotive UAT).
//
// Provisions the "ATL Automotive" dealership through the real durable
// provisioning saga (POST /platform/dealers), activates it once the go-live
// checklist clears, then seeds a representative UAT dataset entirely scoped
// to the new dealer:
//   - vehicles imported through the real Excel preview→apply import flow,
//     using publicly listed ATL makes/models (Audi, BMW, BYD, Honda, Kia,
//     MG, VW, ...) with synthetic UAT VINs and GYD demo prices;
//   - clearly fictional, UAT-labelled leads across pipeline phases with
//     safe non-routable contact details (@example.com, +592-000-xxxx);
//   - sample deals in the safe `desking` stage linked to those leads.
//
// No owner email is supplied, so no invite email is queued; the dealer has
// no SMTP or WhatsApp channel configured, so lead-creation side effects
// (notifications/outreach) cannot send anything externally.
//
// Idempotent: re-running skips the dealer, vehicles (by VIN), leads (by
// name) and deals (by customer name) that already exist.
//
// Run: pnpm --filter @workspace/scripts run seed-atl-uat
// Requires the api-server workflow running in dev (x-test-user-email honored).

import ExcelJS from "exceljs";
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
// UAT dataset — publicly listed ATL makes/models, factual specs only.
// Prices are UAT demonstration values in GYD (whole dollars, no cents).
// VINs are synthetic 17-char UAT identifiers, never real VINs.
// ---------------------------------------------------------------------------

const uatVin = (n: number) => `UATATL${String(n).padStart(11, "0")}`;
// Synthetic 17-character engine numbers. These are UAT identifiers, never
// copied from ATL inventory, and satisfy allocation's vehicle-identity guard.
const uatEngineNumber = (n: number) =>
  `UATATLENG${String(n).padStart(8, "0")}`;

type Row = {
  make: string;
  model: string;
  trim?: string;
  year: number;
  price: number; // GYD
  powertrain: "Petrol" | "Diesel" | "Hybrid" | "EV";
  mileageKm: number;
  exteriorColor: string;
  bodyType: string;
  transmission?: string;
  rangeKm?: number;
  description?: string;
};

const VEHICLES: Row[] = [
  { make: "Audi", model: "Q8", trim: "55 TFSI quattro", year: 2025, price: 42_000_000, powertrain: "Petrol", mileageKm: 0, exteriorColor: "Glacier White", bodyType: "SUV", transmission: "Automatic", description: "UAT sample — publicly listed ATL model" },
  { make: "Audi", model: "Q8 e-tron", year: 2024, price: 38_500_000, powertrain: "EV", mileageKm: 0, exteriorColor: "Mythos Black", bodyType: "SUV", transmission: "Automatic", rangeKm: 500, description: "UAT sample — publicly listed ATL model" },
  { make: "Audi", model: "Q6 e-tron", year: 2025, price: 33_000_000, powertrain: "EV", mileageKm: 0, exteriorColor: "Daytona Grey", bodyType: "SUV", transmission: "Automatic", rangeKm: 520, description: "UAT sample — publicly listed ATL model" },
  { make: "BYD", model: "Atto 8", year: 2027, price: 21_500_000, powertrain: "Hybrid", mileageKm: 0, exteriorColor: "Harbour Grey", bodyType: "SUV", transmission: "Automatic", description: "UAT sample — publicly listed ATL model" },
  { make: "Kia", model: "Picanto", trim: "LX", year: 2024, price: 5_800_000, powertrain: "Petrol", mileageKm: 0, exteriorColor: "Clear White", bodyType: "Hatchback", transmission: "Automatic", description: "UAT sample — publicly listed ATL model" },
  { make: "Kia", model: "Soluto", trim: "EX", year: 2025, price: 6_400_000, powertrain: "Petrol", mileageKm: 0, exteriorColor: "Sparkling Silver", bodyType: "Sedan", transmission: "Automatic", description: "UAT sample — publicly listed ATL model" },
  { make: "Honda", model: "CR-V", trim: "Hybrid", year: 2025, price: 15_500_000, powertrain: "Hybrid", mileageKm: 0, exteriorColor: "Platinum White Pearl", bodyType: "SUV", transmission: "Automatic", description: "UAT sample — publicly listed ATL model" },
  { make: "MG", model: "ZS EV", year: 2024, price: 9_800_000, powertrain: "EV", mileageKm: 0, exteriorColor: "Dover White", bodyType: "SUV", transmission: "Automatic", rangeKm: 440, description: "UAT sample — publicly listed ATL model" },
  { make: "Volkswagen", model: "Tiguan", trim: "Life", year: 2025, price: 13_200_000, powertrain: "Petrol", mileageKm: 0, exteriorColor: "Deep Black Pearl", bodyType: "SUV", transmission: "Automatic", description: "UAT sample — publicly listed ATL model" },
  { make: "BMW", model: "X3", trim: "xDrive20i", year: 2025, price: 22_500_000, powertrain: "Petrol", mileageKm: 0, exteriorColor: "Alpine White", bodyType: "SUV", transmission: "Automatic", description: "UAT sample — publicly listed ATL model" },
  { make: "Jaecoo", model: "J7", year: 2025, price: 10_500_000, powertrain: "Petrol", mileageKm: 0, exteriorColor: "Model Green", bodyType: "SUV", transmission: "Automatic", description: "UAT sample — publicly listed ATL model" },
  { make: "MINI", model: "Cooper S", year: 2025, price: 12_000_000, powertrain: "Petrol", mileageKm: 0, exteriorColor: "Chili Red", bodyType: "Hatchback", transmission: "Automatic", description: "UAT sample — publicly listed ATL model" },
];

// Fictional, clearly UAT-labelled leads — safe non-routable contacts.
const LEADS = [
  { name: "UAT Test — Marlon Grant", email: "uat.marlon.grant@example.com", phone: "+592-000-0101", phase: "new", channel: "walkin", model: "Kia Picanto" },
  { name: "UAT Test — Alicia Persaud", email: "uat.alicia.persaud@example.com", phone: "+592-000-0102", phase: "contacted", channel: "web", model: "Audi Q6 e-tron" },
  { name: "UAT Test — Ryan Chen", email: "uat.ryan.chen@example.com", phone: "+592-000-0103", phase: "qualified", channel: "web", model: "Honda CR-V" },
  { name: "UAT Test — Shania Boodram", email: "uat.shania.boodram@example.com", phone: "+592-000-0104", phase: "proposal", channel: "email", model: "BYD Atto 8" },
  { name: "UAT Test — Devendra Singh", email: "uat.devendra.singh@example.com", phone: "+592-000-0105", phase: "negotiation", channel: "walkin", model: "BMW X3" },
  { name: "UAT Test — Keisha Thomas", email: "uat.keisha.thomas@example.com", phone: "+592-000-0106", phase: "qualified", channel: "web", model: "MG ZS EV" },
] as const;

// Deals (safe desking stage) — customer name matches the lead.
const DEALS = [
  { lead: "UAT Test — Shania Boodram", model: "BYD Atto 8", discount: 0 },
  { lead: "UAT Test — Devendra Singh", model: "BMW X3", discount: 500_000 },
  { lead: "UAT Test — Keisha Thomas", model: "MG ZS EV", discount: 0 },
];

// ---------------------------------------------------------------------------

/**
 * Fail-closed guard for reruns: the resolved dealer must look exactly like
 * the UAT tenant this script owns — no outbound channels (SMTP/WhatsApp)
 * that could reach real people, and no records other than our clearly
 * labelled UAT data. Anything unexpected aborts before any write.
 */
async function assertUatTenant(): Promise<void> {
  const r = await db.execute(sql`select
    (select count(*)::int from smtp_connections where dealer_id = ${dealerId}) as smtp,
    (select count(*)::int from whatsapp_channels where dealer_id = ${dealerId}) as whatsapp,
    (select count(*)::int from vehicles where dealer_id = ${dealerId}
       and (vin is null or vin not like 'UATATL%')) as foreign_vehicles,
    (select count(*)::int from leads where dealer_id = ${dealerId}
       and name not like 'UAT Test%') as foreign_leads,
    (select count(*)::int from deals where dealer_id = ${dealerId}
       and (customer_name is null or customer_name not like 'UAT Test%')) as foreign_deals`);
  const c = r.rows[0] as any;
  const problems: string[] = [];
  if (c.smtp > 0) problems.push(`${c.smtp} SMTP connection(s) configured`);
  if (c.whatsapp > 0) problems.push(`${c.whatsapp} WhatsApp channel(s) configured`);
  if (c.foreign_vehicles > 0) problems.push(`${c.foreign_vehicles} non-UAT vehicle(s)`);
  if (c.foreign_leads > 0) problems.push(`${c.foreign_leads} non-UAT lead(s)`);
  if (c.foreign_deals > 0) problems.push(`${c.foreign_deals} non-UAT deal(s)`);
  if (problems.length > 0) {
    console.error(
      `✗ dealer #${dealerId} "${DEALER_NAME}" does not look like the UAT tenant this script owns — refusing to seed:\n  - ${problems.join("\n  - ")}`,
    );
    process.exit(1);
  }
  console.log("✓ tenant verified as UAT-owned (no outbound channels, only UAT data)");
}

async function ensureDealer(): Promise<void> {
  const list = await api("GET", "/platform/dealers");
  if (list.status !== 200) fail("list dealers", list);
  const existing = (list.json as any[]).find(
    (d) => d.name?.trim().toLowerCase() === DEALER_NAME.toLowerCase(),
  );
  if (existing) {
    dealerId = existing.id;
    console.log(`✓ dealer already exists: #${dealerId} (${existing.status})`);
    // Fail-closed: never seed into a same-name dealer that isn't clearly the
    // UAT tenant this script created. Any non-UAT data or configured outbound
    // channel means it could be a real dealership — abort instead of touching it.
    await assertUatTenant();
    if (existing.status === "active") return;
    if (existing.status !== "provisioning") {
      console.error(
        `✗ dealer #${dealerId} has status "${existing.status}" — refusing to seed`,
      );
      process.exit(1);
    }
    // Resume an interrupted provisioning saga before activating.
    const status = await api("GET", `/platform/dealers/${dealerId}/provisioning`);
    if (status.status !== 200) fail("get provisioning status", status);
    const steps = status.json?.steps ?? [];
    const allDone =
      steps.length > 0 && steps.every((s: any) => s.status === "done");
    if (!allDone) {
      const retry = await api(
        "POST",
        `/platform/dealers/${dealerId}/provisioning/retry`,
      );
      if (retry.status !== 202) fail("saga retry", retry);
      const resumed = (retry.json?.steps ?? []) as any[];
      if (!resumed.every((s) => s.status === "done"))
        fail("saga resume left steps unfinished", retry);
      console.log("✓ interrupted saga resumed to completion");
    }
  } else {
    const created = await api("POST", "/platform/dealers", {
      body: {
        name: DEALER_NAME,
        city: "Kingston",
        country: "Jamaica",
      },
    });
    if (created.status !== 201) fail("create dealer", created);
    dealerId = created.json.dealer.id;
    const steps = created.json.saga?.steps ?? [];
    const allDone = steps.length > 0 && steps.every((s: any) => s.status === "done");
    console.log(
      `✓ dealer #${dealerId} provisioned via saga (${steps.length} steps, all done: ${allDone})`,
    );
    if (!allDone) {
      const retry = await api(
        "POST",
        `/platform/dealers/${dealerId}/provisioning/retry`,
      );
      if (retry.status !== 202) fail("saga retry", retry);
      console.log("✓ saga retried to completion");
    }
  }

  const act = await api("POST", `/platform/dealers/${dealerId}/activate`);
  if (act.status !== 200) fail("activate dealer", act);
  console.log(`✓ dealer #${dealerId} activated`);
}

const IMPORT_HEADERS = [
  "Make", "Model", "Trim", "Year", "VIN", "Engine Number", "Price", "Powertrain",
  "Mileage km", "Exterior Color", "Body Type", "Transmission",
  "Range km", "Description",
];

async function buildWorkbook(
  rows: { row: Row; vinIndex: number }[],
): Promise<Buffer> {
  const data: (string | number)[][] = [IMPORT_HEADERS];
  for (const { row: r, vinIndex } of rows) {
    data.push([
      r.make, r.model, r.trim ?? "", r.year, uatVin(vinIndex),
      uatEngineNumber(vinIndex), r.price, r.powertrain, r.mileageKm,
      r.exteriorColor, r.bodyType,
      r.transmission ?? "", r.rangeKm ?? "", r.description ?? "",
    ]);
  }
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet("Vehicles").addRows(data);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function importVehicles(): Promise<void> {
  const existing = await api("GET", "/vehicles", { dealer: true });
  if (existing.status !== 200) fail("list vehicles", existing);
  const existingByVin = new Map(
    (existing.json as any[]).map((v) => [(v.vin ?? "").toUpperCase(), v]),
  );
  // Keep VIN/engine assignment stable across runs. Existing ATL UAT vehicles
  // missing a valid engine number are deliberately re-imported as updates.
  const pending: { row: Row; vinIndex: number }[] = [];
  VEHICLES.forEach((row, i) => {
    const current = existingByVin.get(uatVin(i + 1));
    if (
      !current ||
      current.engineNumber?.trim()?.toUpperCase() !== uatEngineNumber(i + 1)
    )
      pending.push({ row, vinIndex: i + 1 });
  });
  if (pending.length === 0) {
    console.log(`✓ all ${VEHICLES.length} UAT vehicles already imported`);
    return;
  }

  // Build one workbook with only the missing rows (their stable VINs).
  const buf = await buildWorkbook(pending);

  const makeForm = () => {
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(buf)], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
      "atl-uat-inventory.xlsx",
    );
    return form;
  };

  const preview = await api("POST", "/vehicles/import?mode=preview", {
    form: makeForm(),
    dealer: true,
  });
  if (preview.status !== 200) fail("import preview", preview);
  const pv = preview.json;
  const previewErrors = pv.errors ?? pv.rows?.filter((r: any) => r.errors?.length) ?? [];
  if (Array.isArray(previewErrors) && previewErrors.length > 0) {
    console.error("✗ import preview reported row errors:", JSON.stringify(previewErrors, null, 2));
    process.exit(1);
  }
  console.log(`✓ import preview clean (${pending.length} rows)`);

  const apply = await api("POST", "/vehicles/import?mode=apply", {
    form: makeForm(),
    dealer: true,
  });
  if (apply.status !== 200 && apply.status !== 201) fail("import apply", apply);
  console.log(`✓ import applied: ${JSON.stringify(apply.json?.summary ?? apply.json)}`);
}

async function repairEngineNumbersOnly(): Promise<void> {
  const list = await api("GET", "/platform/dealers");
  if (list.status !== 200) fail("list dealers", list);
  const matches = (list.json as any[]).filter(
    (d) => d.name?.trim().toLowerCase() === DEALER_NAME.toLowerCase(),
  );
  if (matches.length !== 1) {
    console.error(
      `✗ expected exactly one "${DEALER_NAME}" dealer, found ${matches.length}`,
    );
    process.exit(1);
  }
  const dealer = matches[0]!;
  if (dealer.status !== "active") {
    console.error(
      `✗ "${DEALER_NAME}" is ${dealer.status}, not active — refusing repair`,
    );
    process.exit(1);
  }
  dealerId = dealer.id;
  console.log(`✓ repair target: ${DEALER_NAME} #${dealerId}`);

  await startImpersonation();

  const listed = await api("GET", "/vehicles", { dealer: true });
  if (listed.status !== 200) fail("list ATL vehicles for repair", listed);
  const byVin = new Map(
    (listed.json as any[]).map((v) => [(v.vin ?? "").trim().toUpperCase(), v]),
  );

  // The synthetic VIN plus expected make/model is the immutable UAT identity.
  // Refuse a missing or repurposed record; repair mode never inserts vehicles
  // and PATCH sends only engineNumber, so no other vehicle field can change.
  let updated = 0;
  for (const [index, expectedVehicle] of VEHICLES.entries()) {
    const vin = uatVin(index + 1);
    const expectedEngine = uatEngineNumber(index + 1);
    const current = byVin.get(vin);
    if (
      !current ||
      current.make !== expectedVehicle.make ||
      current.model !== expectedVehicle.model
    ) {
      console.error(
        `✗ ${vin} is missing or no longer matches ${expectedVehicle.make} ${expectedVehicle.model} — refusing repair`,
      );
      process.exit(1);
    }
    if (current.engineNumber?.trim()?.toUpperCase() === expectedEngine) continue;

    const patched = await api("PATCH", `/vehicles/${current.id}`, {
      dealer: true,
      body: { engineNumber: expectedEngine },
    });
    if (patched.status !== 200) fail(`repair engine number for ${vin}`, patched);
    if (patched.json?.engineNumber !== expectedEngine) {
      console.error(`✗ ${vin} PATCH did not return the expected engine number`);
      process.exit(1);
    }
    updated += 1;
  }

  const checked = await api("GET", "/vehicles", { dealer: true });
  if (checked.status !== 200) fail("verify repaired vehicles", checked);
  const repairedByVin = new Map(
    (checked.json as any[]).map((v) => [
      (v.vin ?? "").trim().toUpperCase(),
      v.engineNumber?.trim()?.toUpperCase(),
    ]),
  );
  const invalid = VEHICLES.flatMap((_, index) => {
    const vin = uatVin(index + 1);
    return repairedByVin.get(vin) === uatEngineNumber(index + 1) ? [] : [vin];
  });
  if (invalid.length > 0) {
    console.error(`✗ exact engine-number verification failed: ${invalid.join(", ")}`);
    process.exit(1);
  }
  console.log(`✓ engine-number repair updated ${updated} vehicle(s)`);
  console.log(
    `✓ verified exact VIN→engine mapping for all ${VEHICLES.length} ATL UAT vehicles`,
  );
}

async function seedLeads(): Promise<Map<string, number>> {
  const leadIds = new Map<string, number>();
  const existing = await api("GET", "/leads", { dealer: true });
  if (existing.status !== 200) fail("list leads", existing);
  const rows: any[] = existing.json?.leads ?? existing.json ?? [];
  for (const l of rows) leadIds.set(l.name, l.id);

  for (const l of LEADS) {
    if (leadIds.has(l.name)) {
      console.log(`✓ lead already exists: ${l.name}`);
      continue;
    }
    const created = await api("POST", "/leads", {
      dealer: true,
      body: {
        name: l.name,
        email: l.email,
        phone: l.phone,
        channel: l.channel,
        phase: l.phase,
        selectedModel: l.model,
        notes: "UAT sample lead — fictional person, safe non-routable contact details. Not a real customer.",
      },
    });
    if (created.status !== 201) fail(`create lead ${l.name}`, created);
    leadIds.set(l.name, created.json.lead.id);
    console.log(`✓ lead #${created.json.lead.id} — ${l.name} (${l.phase})`);
  }
  return leadIds;
}

async function seedDeals(leadIds: Map<string, number>): Promise<void> {
  const vehiclesRes = await api("GET", "/vehicles", { dealer: true });
  if (vehiclesRes.status !== 200) fail("list vehicles for deals", vehiclesRes);
  const vehicles: any[] = vehiclesRes.json;

  const dealsRes = await api("GET", "/deals", { dealer: true });
  if (dealsRes.status !== 200) fail("list deals", dealsRes);
  const existingDeals: any[] = dealsRes.json?.deals ?? dealsRes.json ?? [];
  const existingCustomers = new Set(existingDeals.map((d) => d.customerName));

  for (const d of DEALS) {
    if (existingCustomers.has(d.lead)) {
      console.log(`✓ deal already exists for ${d.lead}`);
      continue;
    }
    const vehicle = vehicles.find(
      (v) => `${v.make} ${v.model}` === d.model && v.status === "available",
    );
    if (!vehicle) {
      console.error(`✗ no available vehicle matching "${d.model}" for deal`);
      process.exit(1);
    }
    const created = await api("POST", "/deals", {
      dealer: true,
      body: {
        vehicleId: vehicle.id,
        leadId: leadIds.get(d.lead),
        customerName: d.lead,
        stage: "desking",
        vehiclePrice: vehicle.price,
        discount: d.discount,
        otdPrice: vehicle.price - d.discount,
      },
    });
    if (created.status !== 201) fail(`create deal for ${d.lead}`, created);
    console.log(
      `✓ deal #${created.json.id} — ${d.lead} → ${d.model} (desking)`,
    );
  }
}

async function verify(): Promise<void> {
  const [vehicles, leads, deals] = await Promise.all([
    api("GET", "/vehicles", { dealer: true }),
    api("GET", "/leads", { dealer: true }),
    api("GET", "/deals", { dealer: true }),
  ]);
  const vCount = (vehicles.json as any[])?.length ?? 0;
  const lRows: any[] = leads.json?.leads ?? leads.json ?? [];
  const dRows: any[] = deals.json?.deals ?? deals.json ?? [];
  console.log(
    `\nATL Automotive UAT (#${dealerId}): ${vCount} vehicles, ${lRows.length} leads, ${dRows.length} deals`,
  );
  const foreignVehicle = (vehicles.json as any[]).find(
    (v) => v.dealerId && v.dealerId !== dealerId,
  );
  if (foreignVehicle) {
    console.error("✗ tenant isolation breach: foreign vehicle visible", foreignVehicle.id);
    process.exit(1);
  }
  console.log("✓ all visible records scoped to ATL Automotive");
}

async function startImpersonation(): Promise<void> {
  // Super admins need an audited impersonation window to touch dealer-scoped
  // data. Elevated mode allows writes but still blocks money-posting, gate
  // resolution, and customer sends — exactly what a UAT seed wants.
  const grant = await api("POST", "/platform/impersonation", {
    body: {
      dealerId,
      reason: "Seed ATL Automotive UAT dataset (vehicles, leads, deals)",
      mode: "elevated",
    },
  });
  if (grant.status !== 200 && grant.status !== 201)
    fail("start impersonation", grant);
  console.log("✓ elevated impersonation window opened");
}

async function main() {
  if (process.argv.includes("--repair-engine-numbers")) {
    await repairEngineNumbersOnly();
    console.log("\nDone — ATL Automotive vehicle identities are allocation-ready.");
    return;
  }
  await ensureDealer();
  await startImpersonation();
  await importVehicles();
  const leadIds = await seedLeads();
  await seedDeals(leadIds);
  await verify();
  console.log("\nDone — ATL Automotive UAT is ready.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
