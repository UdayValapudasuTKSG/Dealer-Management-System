import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ExcelJS from "exceljs";
import { parsePartsXlsx } from "./parts-import-xlsx";
import { mapImportRows, validateImportRows } from "./parts-import-validation";
import { CreatePartBody, UpdatePartBody, CreatePartResponse } from "@workspace/api-zod";

const options = { mode: "upsert" as const, applyStock: false };
async function sample() {
  const matrix = await parsePartsXlsx(await readFile(new URL("../../../../attached_assets/pricing_format_1790108663981.xlsx", import.meta.url)));
  return mapImportRows(matrix, options);
}
test("actual five-row workbook preserves cached precision, pre-VAT prices, variable duty and markup", async () => {
  const source = await sample();
  const { rows, errors } = validateImportRows(source, options, [{ category: null, markupFactor: 99 }]);
  assert.deepEqual(errors, []);
  assert.equal(rows.length, 5);
  assert.equal(rows[0].unitCost, 206457.47);
  assert.equal(rows[0].unitPrice, 227103.21);
  assert.equal(rows[0].pricingDetails?.finalSellingPriceGyd, 258897.6618624);
  assert.equal(rows[0].pricingDetails?.landedCostGyd, 206457.4656);
  assert.equal(rows[2].unitPrice, 19856.79); // Actual 100% markup, not header 10%.
  assert.equal(rows[3].unitPrice, 19856.79);
  assert.equal(rows[4].pricingDetails?.dutyRate, 0.3);
  for (const row of rows) {
    assert.equal(row.stock, undefined);
    assert.equal(row.pricingDetails?.quantity, 1);
  }
  const stock = validateImportRows(source, { ...options, applyStock: true }, []);
  assert.deepEqual(stock.errors, []);
  assert.ok(stock.rows.every(row => row.stock === 1));
});
test("row-level malformed numbers, fractional quantities, rates and inconsistent cached arithmetic fail", async () => {
  const source = (await sample()).slice(0, 1);
  for (const [field, value] of Object.entries({ unitCostUsd: "NaN", dutyRate: "20", vatRate: "-1", stock: "1.5", totalUsd: "1", dutyGyd: "1", vatGyd: "1", landedCostGyd: "1", finalSellingPriceGyd: "1" })) {
    const result = validateImportRows([{ ...source[0], [field]: value }], options, []);
    assert.ok(result.errors.length > 0, field);
    assert.ok(result.errors.every(error => error.row === 2));
  }
});
test("missing/nonnumeric cached results and Excel errors are explicit errors; zero cache is accepted", async () => {
  for (const value of [{ formula: "1+1" }, { formula: "1+1", result: "bad" }, { error: "#VALUE!" }]) {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Prices").getCell("A1").value = value as ExcelJS.CellValue;
    await assert.rejects(parsePartsXlsx(Buffer.from(await workbook.xlsx.writeBuffer())), /cached result|Excel error/);
  }
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("Prices").getCell("A1").value = { formula: "0", result: 0 };
  assert.deepEqual(await parsePartsXlsx(Buffer.from(await workbook.xlsx.writeBuffer())), [["0"]]);
});
test("API schemas retain metadata, accept explicit clear, reject invalid values; legacy import omits metadata", async () => {
  const { rows } = validateImportRows(await sample(), options, []);
  const input = { sku: "TEST", name: "Test", pricingDetails: rows[0].pricingDetails };
  assert.deepEqual(CreatePartBody.parse(input).pricingDetails, input.pricingDetails);
  assert.equal(UpdatePartBody.parse({ pricingDetails: null }).pricingDetails, null);
  assert.equal(UpdatePartBody.parse({ name: "Changed" }).pricingDetails, undefined);
  assert.equal(CreatePartBody.safeParse({ ...input, pricingDetails: { vatRate: 14 } }).success, false);
  assert.equal(CreatePartBody.safeParse({ ...input, pricingDetails: { quantity: 0.5 } }).success, false);
  assert.deepEqual(CreatePartResponse.parse({ ...input, id: 1, category: "general", unitCost: 1, unitPrice: 2, stock: 0, reorderLevel: 5, createdAt: new Date() }).pricingDetails, input.pricingDetails);
  assert.equal(validateImportRows([{ sku: "A", name: "A", unitCost: "1", unitPrice: "2" }], options, []).rows[0].pricingDetails, undefined);
});