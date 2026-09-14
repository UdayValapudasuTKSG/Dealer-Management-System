/**
 * DB-free handover regression checks.
 *
 * Exercises the field resolver (including overrides and reviewed-history
 * unknowns), renders deliberately long values, and extracts the generated PDF
 * to prove that no value is replaced by PDFKit's ellipsis behavior.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { buildHandoverPdf } from "../lib/document-pdfs";
import {
  resolveHandoverFieldValues,
  type HandoverFieldValues,
} from "../lib/handover-fields";
import type { Delivery, Vehicle } from "@workspace/db";

const OUT_DIR = "/tmp/handover-pdf-regression";
const PDF_PATH = `${OUT_DIR}/handover-long-text.pdf`;
const TZ = "America/Guyana";

const ownerContact = {
  name: "Alicia Damaris Joseph",
  email: "alicia.joseph@example.com",
  phone: "+592 600 1234",
  address:
    "Lot 18 Republic Park, East Bank Demerara, Georgetown, Demerara-Mahaica, Guyana",
};

const vehicle = {
  id: 48,
  make: "BYD",
  model: "SEALION 7 Premium Extended Range",
  vin: "LC0C6C4D9R1234567",
  mileageKm: 123456,
} as Vehicle;

const baseDelivery = {
  id: 48,
  dealId: 1001,
  vehicleId: vehicle.id,
  customerId: 2001,
  customerName: ownerContact.name,
  advisorUserId: 3001,
  registrationNumber: "PAB1234",
  insuranceProvider: "Assuria",
  insurancePolicy: "POLICY-2026-VERY-LONG-0001",
  deliveredAt: new Date("2026-09-13T14:00:00.000Z"),
  appointmentAt: null,
  importMetadata: null,
  handoverOverrides: {},
} as unknown as Delivery;

function resolve(
  delivery: Delivery = baseDelivery,
): HandoverFieldValues {
  return resolveHandoverFieldValues(
    delivery,
    vehicle,
    "Delivery Advisor",
    "Sales Advisor",
    ownerContact,
    "INV-2026-0048",
    TZ,
    new Date("2026-09-14T12:00:00.000Z"),
  ).values;
}

function extraction(pdfPath: string): string {
  try {
    const script = [
      "import fitz, sys",
      "doc = fitz.open(sys.argv[1])",
      "print('\\n'.join(page.get_text() for page in doc))",
    ].join("\n");
    return execFileSync("python3", ["-c", script, pdfPath], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    return execFileSync("pdftotext", [pdfPath, "-"], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
  }
}

async function main(): Promise<void> {
  const defaults = resolve();
  assert.equal(defaults.customerAddress, ownerContact.address);
  assert.equal(defaults.salesperson, "Sales Advisor");
  assert.equal(defaults.invoiceNumber, "INV-2026-0048");
  assert.equal(defaults.make, vehicle.make);
  assert.equal(defaults.model, vehicle.model);
  assert.equal(defaults.vin, vehicle.vin);
  assert.equal(defaults.mileage, "123,456 km");
  assert.equal(defaults.stockNumber, "V-00048");

  const overridden = resolve({
    ...baseDelivery,
    handoverOverrides: {
      customerAddress: "A deliberately corrected full address, Georgetown, Guyana",
      salesperson: "Override Salesperson",
      invoiceNumber: "OVERRIDE-INVOICE",
      make: "Override Make",
    },
  } as unknown as Delivery);
  assert.equal(
    overridden.customerAddress,
    "A deliberately corrected full address, Georgetown, Guyana",
  );
  assert.equal(overridden.salesperson, "Override Salesperson");
  assert.equal(overridden.invoiceNumber, "OVERRIDE-INVOICE");
  assert.equal(overridden.make, "Override Make");
  assert.equal(overridden.model, vehicle.model);

  const importedUnknowns = resolve({
    ...baseDelivery,
    deliveredAt: null,
    appointmentAt: new Date("2026-09-13T14:00:00.000Z"),
    importMetadata: {
      kind: "reviewed_delivery_history",
      mileageKnown: false,
    },
  } as unknown as Delivery);
  assert.equal(importedUnknowns.date, "");
  assert.equal(importedUnknowns.mileage, "");

  const longName =
    "Alicia Damaris Joseph-Smith Montgomery-Worthington";
  const longAddress =
    "Lot 18 Republic Park, East Bank Demerara, Georgetown, Demerara-Mahaica, " +
    "Guyana, near the National Exhibition Centre, delivery entrance at the rear";
  const longEmail =
    "alicia.damaris.joseph.montgomery.worthington@example-dealership.test";
  const longSalesperson = "Alexandra Penelope Montgomery-Smythe-Worthington";
  const longDelivery = {
    ...baseDelivery,
    customerName: longName,
    handoverOverrides: {
      customerAddress: longAddress,
      customerEmail: longEmail,
      customerPhone: "+592 600 1234 / +592 600 5678",
      salesperson: longSalesperson,
      invoiceNumber: "INV-2026-0048-EXTENDED-FINAL-CUSTOMER-COPY",
      make: "BYD Electric Vehicle Division",
      model: "SEALION 7 Premium Extended Range AWD",
      vin: "LC0C6C4D9R1234567",
      mileage: "123,456 km verified at handover",
      keyNumber: "KEY-PRIMARY-AND-SPARE-RECEIVED",
      stockNumber: "V-00048-LONG-STOCK-REFERENCE",
    },
  } as unknown as Delivery;
  const pdf = await buildHandoverPdf(longDelivery, vehicle, "Delivery Advisor", TZ, {
    customerName: longName,
    customerAddress: longAddress,
    customerEmail: longEmail,
    customerPhone: "+592 600 1234 / +592 600 5678",
    salesAdvisorName: longSalesperson,
    invoiceNumber: "INV-2026-0048-EXTENDED-FINAL-CUSTOMER-COPY",
    dealerName: "AURA Motors Guyana",
    dealerAddress: "Georgetown, Guyana",
    mileageKnown: true,
    overrides: longDelivery.handoverOverrides,
  });
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(PDF_PATH, pdf);
  const text = extraction(PDF_PATH);
  // Text extractors may insert whitespace at a visual line break (including in
  // an unbroken email/VIN token), so compare both rendered text and a compact
  // representation while retaining every non-whitespace character.
  const compactText = text.replace(/\s+/g, "");
  for (const expected of [
    longName,
    longAddress,
    longEmail,
    longSalesperson,
    "INV-2026-0048-EXTENDED-FINAL-CUSTOMER-COPY",
    "BYD Electric Vehicle Division",
    "SEALION 7 Premium Extended Range AWD",
    "LC0C6C4D9R1234567",
    "123,456 km verified at handover",
    "KEY-PRIMARY-AND-SPARE-RECEIVED",
    "V-00048-LONG-STOCK-REFERENCE",
    "PAB1234",
  ]) {
    assert.ok(
      compactText.includes(expected.replace(/\s+/g, "")),
      `PDF is missing complete value: ${expected}`,
    );
  }
  assert.ok(!text.includes("…"), "handover PDF contains an ellipsis");
  assert.ok(!text.includes("..."), "handover PDF contains a truncation marker");
  assert.equal((text.match(/CUSTOMER DETAILS/g) ?? []).length, 2);
  console.log(`Handover PDF checks passed. Synthetic PDF written to ${PDF_PATH}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});