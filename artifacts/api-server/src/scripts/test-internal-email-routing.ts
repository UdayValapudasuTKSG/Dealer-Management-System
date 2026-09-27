import assert from "node:assert/strict";
import {
  chooseInternalRecipients,
  customInternalDedupeKey,
  internalDeliveryAllowed,
  INTERNAL_EMAIL_MODULES,
} from "../lib/internal-email-recipients";

// Pure contract checks: no queue worker, database fixtures, or outbound SMTP.
assert.equal(INTERNAL_EMAIL_MODULES["lead.new"], "leads");
assert.equal(INTERNAL_EMAIL_MODULES["lead.sla.breach.manager"], "leads");
assert.equal(INTERNAL_EMAIL_MODULES["test_drive_owner_invite"], "leads");
assert.equal(INTERNAL_EMAIL_MODULES["service.summary.management"], "service");
assert.equal(INTERNAL_EMAIL_MODULES["collision.claim.action"], "service");
assert.equal(INTERNAL_EMAIL_MODULES["refund.approved.finance"], "finance");
assert.equal(INTERNAL_EMAIL_MODULES["parts.inventory.reorder"], "parts");
assert.equal(INTERNAL_EMAIL_MODULES["lead_assignment"], undefined); // customer
assert.equal(INTERNAL_EMAIL_MODULES["invoice.generated"], undefined); // customer
assert.equal(INTERNAL_EMAIL_MODULES["smtp_test"], undefined);
const eligible = [{ id: 2 }, { id: 3 }, { id: 9 }];
assert.deepEqual(chooseInternalRecipients(eligible, []), []);
assert.deepEqual(chooseInternalRecipients(eligible, [3]), [{ id: 3 }]);
assert.deepEqual(chooseInternalRecipients(eligible, [999]), []);
const staff = [{ id: 2, email: "gm@example.invalid" }, { id: 3, email: "advisor@example.invalid" }];
assert.equal(internalDeliveryAllowed(null, staff, staff[0]!.email, false), true);
assert.equal(internalDeliveryAllowed(null, staff, staff[1]!.email, true), false);
assert.equal(internalDeliveryAllowed([], staff, staff[0]!.email, false), false);
assert.equal(internalDeliveryAllowed([3], staff, staff[0]!.email, false), false);
assert.equal(internalDeliveryAllowed([3], staff, "ADVISOR@example.invalid", true), true);
assert.equal(internalDeliveryAllowed([2], staff.slice(1), staff[0]!.email, true), false);
assert.equal(
  customInternalDedupeKey("lead:new:42:u2", 3),
  customInternalDedupeKey("lead:new:42:u9", 3),
);
assert.notEqual(
  customInternalDedupeKey("lead:new:42:u2", 3),
  customInternalDedupeKey("lead:new:42:u2", 9),
);
console.log("Internal email routing contract passed (no email sent)");