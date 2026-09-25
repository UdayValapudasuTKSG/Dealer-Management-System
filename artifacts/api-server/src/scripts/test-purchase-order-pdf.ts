import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PDFDocument } from "pdf-lib";
import { buildPurchaseOrderPdf, type PrintablePurchaseOrder } from "../lib/purchase-order-pdf";

const order: PrintablePurchaseOrder = {
  id: 42, reference: "DEMO-PO-42", createdAt: new Date("2026-08-10T15:00:00Z"),
  expectedDate: "2026-08-25", notes: "Confirm delivery before dispatch.",
  lines: [{ partName: "Synthetic example brake assembly", quantity: 2, unitCost: 1250,
    landedCostComponents: { freight: 125, duty: 75 } }],
};
const supplier = {
  name: "Sample Supplier (synthetic)", contactName: null, address: null, phone: null, email: null,
};
const dealer = { address: "Sample Street (synthetic)", city: "Example City",
  country: "Example Country", servicePhone: null };
const output = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../.agents/outputs/purchase-order-sample.pdf");
await mkdir(dirname(output), { recursive: true });
const pdf = await buildPurchaseOrderPdf(order, dealer, supplier,
  { displayName: "SAMPLE DEALERSHIP — SYNTHETIC DATA", logo: null }, "America/Guyana");
await writeFile(output, pdf);
assert.ok((await PDFDocument.load(pdf)).getPageCount() <= 2, "short PO has no blank template page");
const extracted = execFileSync("pdftotext", ["-layout", output, "-"], { encoding: "utf8" });
for (const expected of [
  "SAMPLE DEALERSHIP", "Sample Supplier", "DEMO-PO-42", "GYD 2,700.00",
  "Please reference the Purchase Order number on all shipping documents, invoices, and",
  "Notify us immediately if unable to deliver as specified or by the requested delivery date.",
  "All goods are subject to inspection and approval upon arrival.",
  "Additional PO Notes", "Confirm delivery before dispatch.",
  "Authorized Signature:", "Date Signed:", "Name:", "Title:",
]) {
  assert.ok(extracted.includes(expected), `Missing ${expected}`);
}
for (const forbidden of ["GT Automotive", "CAM Motors", "Kim Chong", "gtautomotive.gy", "Net 30", "Tax (0%)"]) {
  assert.ok(!extracted.includes(forbidden), `Sample-template data leaked: ${forbidden}`);
}
const second = await buildPurchaseOrderPdf(order,
  { ...dealer, address: "Other configured address", servicePhone: "OTHER-CONTACT" },
  { ...supplier, name: "Other configured supplier" },
  { displayName: "OTHER DEALERSHIP", logo: null }, "Pacific/Auckland");
const secondText = execFileSync("pdftotext", ["-layout", "-", "-"], {
  input: second, encoding: "utf8",
});
assert.ok(secondText.includes("OTHER DEALERSHIP"));
assert.ok(secondText.includes("OTHER-CONTACT"));
assert.ok(secondText.includes("Other configured supplier"));
assert.ok(!secondText.includes("SAMPLE DEALERSHIP"));
assert.ok(!secondText.includes("Sample Supplier"));

const longOrder: PrintablePurchaseOrder = {
  ...order,
  notes: "Handle carefully. ".repeat(85),
  lines: Array.from({ length: 35 }, (_, i) => ({
    partName: `Synthetic line ${i + 1} ` + "long wrapping component description ".repeat(16),
    quantity: i + 1, unitCost: 10.25, landedCostComponents: {},
  })),
};
const longPdf = await buildPurchaseOrderPdf(longOrder, dealer, supplier,
  { displayName: "SAMPLE DEALERSHIP — SYNTHETIC DATA", logo: null }, "America/Guyana");
const pageCount = (await PDFDocument.load(longPdf)).getPageCount();
assert.ok(pageCount >= 3 && pageCount <= 20, `Unexpected sparse page count: ${pageCount}`);
const longText = execFileSync("pdftotext", ["-layout", "-", "-"], { input: longPdf, encoding: "utf8" });
const pages = longText.split("\f").filter((page) => page.trim());
assert.equal(pages.length, pageCount, "pages must all contain extractable content");
for (const page of pages) assert.ok(page.trim().length > 100, "No mostly blank continuation page");
assert.ok(longText.includes("Synthetic line 35"));
assert.ok(longText.includes("Authorization"));
assert.ok(longText.includes("Total:"));
assert.ok(longText.includes("All goods are subject to inspection and approval upon arrival."));
console.log(`Purchase order PDF tests passed (${pageCount} bounded stress pages). Sample: ${output}`);