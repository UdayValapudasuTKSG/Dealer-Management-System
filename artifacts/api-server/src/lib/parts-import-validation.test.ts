import assert from "node:assert/strict";
import { test } from "node:test";
import { mapImportRows, parseCsv, validateImportRows } from "./parts-import-validation";

const options = { mode: "upsert" as const };
const policies = [{ category: null, markupFactor: 1.2 }, { category: "brakes", markupFactor: 1.5 }];
test("CSV quoting, mappings and category/global prices", () => {
  const source = mapImportRows(parseCsv('Code,Title,Cost,category\r\nA,"Brake, rear",10,brakes\r\nB,Filter,20,general'), { ...options, mapping: { sku: "Code", name: "Title" } });
  const result = validateImportRows(source, options, policies);
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
  assert.deepEqual(new Set(errors.map(e => e.field)), new Set(["name", "unitCost", "costingMethod", "reorderMax", "stock"]));
});
test("reject existing SKU and preserve omitted stock", () => {
  const source = [{ sku: "A", name: "A", unitCost: "1" }];
  assert.equal(validateImportRows(source, { mode: "reject" }, policies, new Map([["A", { category: "general" }]])).errors.length, 1);
  assert.equal(validateImportRows(source, options, policies).rows[0].stock, undefined);
});
test("no silent pricing fallback; explicit zero price retained", () => {
  assert.equal(validateImportRows([{ sku: "A", name: "A", unitCost: "1" }], options, []).errors.length, 1);
  assert.equal(validateImportRows([{ sku: "A", name: "A", unitCost: "1", unitPrice: "0" }], options, []).rows[0].unitPrice, 0);
});
test("unterminated CSV and ambiguous headers rejected", () => {
  assert.throws(() => parseCsv('sku,name\nA,"bad'), /Unterminated/);
  assert.throws(() => mapImportRows([["sku", "sku"], ["A", "B"]], options), /Duplicate/);
});