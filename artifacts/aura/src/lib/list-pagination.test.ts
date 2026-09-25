import assert from "node:assert/strict";
import test from "node:test";
import { paginate } from "./list-pagination.ts";

test("slices filtered and sorted rows without changing the source", () => {
  const source = Array.from({ length: 121 }, (_, i) => ({ id: i + 1 }));
  const filtered = source.filter(row => row.id % 2 === 0).reverse();
  const second = paginate(filtered, 2, 25);
  assert.equal(second.total, 60);
  assert.equal(second.pages, 3);
  assert.deepEqual(second.items.map(row => row.id), filtered.slice(25, 50).map(row => row.id));
  assert.equal(source[0].id, 1);
  assert.equal(paginate(filtered, 2, 50).items.length, 10);
  assert.equal(paginate(source, 1, 100).items.length, 100);
});

test("clamps stale pages after data shrinks, and handles empty lists", () => {
  assert.deepEqual(paginate([1, 2, 3], 100, 25), { items: [1, 2, 3], total: 3, pages: 1, page: 1 });
  assert.deepEqual(paginate([], 9, 25), { items: [], total: 0, pages: 1, page: 1 });
});