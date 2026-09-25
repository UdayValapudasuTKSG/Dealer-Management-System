import assert from "node:assert/strict";
import { test } from "node:test";
import { mapImportRows, parseCsv, validateImportRows } from "./parts-import-validation";

const options = { mode: "upsert" as const };
const policies = [{ category: null, markupFactor: 1.2 }, { category: "brakes", markupFactor: 1.5 }];
const storage = { locations: [{ id: 7, name: "Main", active: true }], bins: [{ id: 9, locationId: 7, code: "A", active: true }] };
test("CSV quoting, mappings and category/global prices", () => {
  const source = mapImportRows(parseCsv('Code,Title,Cost,category,Location ID,Bin ID\r\nA,"Brake, rear",10,brakes,7,9\r\nB,Filter,20,general,7,9'), { ...options, mapping: { sku: "Code", name: "Title" } });
  const result = validateImportRows(source, options, policies, new Map(), undefined, [], storage);
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows[0].unitPrice, 15);
  assert.equal(result.rows[1].unitPrice, 24);
});
test("duplicates remain errors in upsert mode, including across chunks", () => {
  const seen = new Map<string, number>();
  const source = [{ sku: "A", name: "A", unitCost: "1" }];
  validateImportRows(source, options, policies, new Map(), { offset: 0, seen });
  const result = validateImportRows(source, options, policies, new Map(), { offset: 500, seen });
  assert.equal(result.errors[0].row, 502);
  assert.match(result.errors[0].message, /Duplicate/);
});
test("missing, negative, invalid costing, reorder and unsafe stock rejected", () => {
  const { errors } = validateImportRows([{ sku: "A", name: "", unitCost: "-1", costingMethod: "bogus", reorderMin: "5", reorderMax: "2", stock: "1" }], options, policies);
  assert.deepEqual(new Set(errors.map(e => e.field)), new Set(["name", "unitCost", "costingMethod", "reorderMax", "stock", "locationId", "binId"]));
});
test("reject existing SKU and preserve omitted stock", () => {
  const source = [{ sku: "A", name: "A", unitCost: "1" }];
  assert.equal(validateImportRows(source, { mode: "reject" }, policies, new Map([["A", { category: "general" }]])).errors.length, 1);
  assert.equal(validateImportRows(source, options, policies).rows[0].stock, undefined);
});
test("no silent pricing fallback; explicit zero price retained", () => {
  assert.deepEqual(validateImportRows([{ sku: "A", name: "A", unitCost: "1" }], options, []).errors.map(e => e.field), ["locationId", "binId", "unitPrice"]);
  assert.equal(validateImportRows([{ sku: "A", name: "A", unitCost: "1", unitPrice: "0" }], options, []).rows[0].unitPrice, 0);
});
test("unterminated CSV and ambiguous headers rejected", () => {
  assert.throws(() => parseCsv('sku,name\nA,"bad'), /Unterminated/);
  assert.throws(() => mapImportRows([["sku", "sku"], ["A", "B"]], options), /Duplicate/);
});
test("new part requires active same-dealer location and bin, even with zero stock", () => {
  const base = { sku: "A", name: "A", unitCost: "1", stock: "0" };
  const validate = (extra: Record<string, string>) =>
    validateImportRows([{ ...base, ...extra }], { ...options, applyStock: true }, policies, new Map(), undefined, [], storage);
  assert.deepEqual(validate({}).errors.map(e => e.field), ["locationId", "binId"]);
  assert.deepEqual(validate({ locationId: "7", binId: "99" }).errors.map(e => e.field), ["binId"]);
  assert.deepEqual(validate({ locationId: "8", binId: "9" }).errors.map(e => e.field), ["locationId", "binId"]);
  assert.deepEqual(validate({ locationId: "7", binId: "9" }).errors, []);
});
test("existing metadata updates preserve storage and explicit stock changes require both IDs", () => {
  const old = new Map([["A", { category: "general" }]]);
  const row = { sku: "A", name: "A", unitCost: "1", stock: "3" };
  const metadata = validateImportRows([row], options, policies, old);
  assert.equal(metadata.rows[0].stock, 3);
  assert.ok(metadata.errors.some(e => e.field === "stock"));
  const noStock = validateImportRows([{ sku: "A", name: "A", unitCost: "1" }], options, policies, old);
  assert.deepEqual(noStock.errors, []);
  assert.ok(validateImportRows([row], { ...options, applyStock: true }, policies, old).errors.some(e => e.field === "binId"));
  assert.deepEqual(validateImportRows([{ ...row, locationId: "7", binId: "9" }], { ...options, applyStock: true }, policies, old, undefined, [], storage).errors, []);
  const unchanged = new Map([["A", { category: "general", stock: 3 }]]);
  assert.deepEqual(validateImportRows([row], { ...options, applyStock: true }, policies, unchanged).errors, [],
    "An unchanged exported aggregate does not need a new storage assignment");
});