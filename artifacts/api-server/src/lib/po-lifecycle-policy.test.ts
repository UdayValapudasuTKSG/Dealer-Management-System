import assert from "node:assert/strict";
import { test } from "node:test";
import { canEmailPo, nextPoStatus } from "./po-lifecycle-policy";
test("PO lifecycle requires review and separate approval", () => {
  assert.equal(nextPoStatus("draft", "submit", 1, 1), "pending_review");
  assert.equal(nextPoStatus("pending_review", "approve", 1, 2), "approved");
  assert.equal(nextPoStatus("pending_review", "return", 1, 2), "draft");
  assert.throws(() => nextPoStatus("draft", "approve", 1, 2));
  assert.throws(() => nextPoStatus("sent", "cancel", 1, 2));
  assert.throws(() => nextPoStatus("pending_review", "approve", 1, 1));
  assert.equal(nextPoStatus("pending_review", "approve", 1, 1, true), "approved");
});
test("approved-only send and explicit legacy-compatible resends", () => {
  for (const status of ["draft", "pending_review", "ordered", "sent", "received", "cancelled"]) assert.equal(canEmailPo(status, false), false);
  assert.equal(canEmailPo("approved", false), true);
  assert.equal(canEmailPo("sent", true), true);
  assert.equal(canEmailPo("ordered", true), false);
  assert.equal(canEmailPo("ordered", true, true), true);
  assert.equal(canEmailPo("draft", true), false);
});