import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { indexInventory, searchInventory } from "./inventory-search";

const catalogue = Array.from({ length: 20_000 }, (_, id) => ({
  id, sku: `SKU-${id}`, name: `Brake filter ${id}`, barcode: `000${id}`, stock: id % 10,
}));
const index = indexInventory(catalogue);
assert.equal(searchInventory(index, "").parts.length, 50);
assert.equal(searchInventory(index, "").hasMore, true);
assert.equal(searchInventory(index, "SKU-19999").parts[0]?.id, 19999);
assert.equal(searchInventory(index, "  FILTER   sku-19999 ").parts[0]?.id, 19999);
assert.equal(searchInventory(index, "00019999").parts[0]?.id, 19999);
assert.equal(searchInventory(index, "unknown").parts.length, 0);
assert.equal(searchInventory(index, "SKU-19999").hasMore, false);
assert.equal(searchInventory(indexInventory(catalogue.slice(0, 50)), "").hasMore, false);
assert.equal(searchInventory([], "").parts.length, 0);
const started = performance.now();
for (let i = 0; i < 100; i++) searchInventory(index, `SKU-${19900 + i}`);
console.log(`PASS: bounded rendering, full-catalogue lookup, case/whitespace, barcode, empty results. 100 searches / 20,000 parts: ${(performance.now() - started).toFixed(1)}ms`);
