import { strict as assert } from "node:assert";
import { matchingParts } from "./barcode-match";

const parts = [
  { id: 1, sku: "FILTER-A", barcode: "0012345" },
  { id: 2, sku: "FILTER-B", barcode: "12345" },
  { id: 3, sku: "HORN-1", barcode: null },
];
assert.deepEqual(matchingParts(parts, " 0012345\r\n").map(p => p.id), [1]);
assert.deepEqual(matchingParts(parts, "12345").map(p => p.id), [2]);
assert.deepEqual(matchingParts(parts, "horn-1").map(p => p.id), [3]);
assert.deepEqual(matchingParts(parts, "1234"), []);
assert.deepEqual(matchingParts(parts, " \n"), []);
assert.deepEqual(matchingParts(parts, "unknown"), []);
assert.equal(matchingParts([...parts, { id: 4, sku: "other", barcode: "0012345" }], "0012345").length, 2);
assert.equal(matchingParts([...parts, { id: 4, sku: "0012345", barcode: null }], "0012345").length, 2);
assert.deepEqual(matchingParts([{ sku: "A/B-01", barcode: null }], "A/B-01").map(p => p.sku), ["A/B-01"]);
console.log("Barcode matching passed: exact match, leading zeroes, SKU, unknown and ambiguous codes.");
