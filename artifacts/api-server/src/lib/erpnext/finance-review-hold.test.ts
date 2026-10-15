import { test } from "node:test";
import assert from "node:assert/strict";
import { isFinanceReviewHeld } from "./finance-review-hold";

test("any persisted hold marker is fail-closed", () => {
  for (const value of [true, false, null, "", {}, { previousStatus: "queued" }]) {
    assert.equal(isFinanceReviewHeld({ financeReviewHold: value }), true);
  }
});
test("ordinary jobs and inherited markers do not count as stored JSON holds", () => {
  assert.equal(isFinanceReviewHeld({}), false);
  assert.equal(isFinanceReviewHeld(null), false);
  assert.equal(isFinanceReviewHeld(Object.create({ financeReviewHold: true })), false);
});
