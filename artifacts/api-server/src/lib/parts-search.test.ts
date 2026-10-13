import { test } from "node:test";
import assert from "node:assert/strict";
import { partsSearchTerms, literalPartPattern } from "./parts-search";
import { feedbackDueAt } from "./feedback-automation-policy";

test("multiple part identifiers are OR terms while names retain spaces", () => {
  assert.deepEqual(partsSearchTerms("oil filter, SKU-1; brake pad\n12345\r\nSKU-1"), ["oil filter", "SKU-1", "brake pad", "12345"]);
});
test("empty separators do not introduce match-all terms", () => {
  assert.deepEqual(partsSearchTerms(" , ; \n"), []);
});
test("wildcards are literal characters, not a way to broaden a search", () => {
  assert.equal(literalPartPattern("A_10%\\x"), "%A\\_10\\%\\\\x%");
});
test("two-day feedback delay is 48 hours after completion, not before", () => {
  const complete = new Date("2026-10-13T16:30:00Z");
  assert.equal(feedbackDueAt(complete, 2).toISOString(), "2026-10-15T16:30:00.000Z");
  assert.equal(feedbackDueAt(complete, 0).getTime(), complete.getTime());
  assert.equal(feedbackDueAt(new Date("2026-12-31T23:59:00Z"), 2).toISOString(), "2027-01-02T23:59:00.000Z");
});
