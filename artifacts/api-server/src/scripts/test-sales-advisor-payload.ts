import assert from "node:assert/strict";
import {
  enrichLegacySalesAdvisorPayload,
  resolveSalesAdvisorName,
  selectSalesAdvisorName,
  snapshotSalesAdvisorPayload,
} from "../lib/sales-advisor";

type Fixture = Parameters<typeof selectSalesAdvisorName>[0];

const ownedLead: Fixture = {
  dealerId: 11,
  ownerUserId: 42,
  assignedTo: "Stale legacy label",
};
assert.equal(
  selectSalesAdvisorName(ownedLead, "  Keiron Brathwaite  "),
  "Keiron Brathwaite",
  "the authorized users.name is the advisor snapshot",
);
assert.equal(
  selectSalesAdvisorName(ownedLead, null),
  "",
  "an owner without an authorized same-dealer full name stays unassigned",
);
const lookupCalls: Array<[number, number]> = [];
assert.equal(
  await resolveSalesAdvisorName(ownedLead, async (dealerId, ownerUserId) => {
    lookupCalls.push([dealerId, ownerUserId]);
    return dealerId === 11 && ownerUserId === 42
      ? "Dealer Eleven Owner"
      : "Other Dealer Owner";
  }),
  "Dealer Eleven Owner",
  "owner lookup receives the lead dealer scope and owner id",
);
assert.deepEqual(lookupCalls, [[11, 42]]);
assert.equal(
  await resolveSalesAdvisorName(
    { dealerId: 12, ownerUserId: 42, assignedTo: "Wrong dealer label" },
    async (dealerId) => (dealerId === 11 ? "Other Dealer Owner" : null),
  ),
  "",
  "an owner from another dealer does not fall back to a cross-dealer label",
);
assert.equal(
  await resolveSalesAdvisorName(
    { dealerId: 11, ownerUserId: 42, assignedTo: "Legacy label" },
    async () => "owner@example.com",
  ),
  "",
  "a users.name email placeholder is not exposed",
);
assert.equal(
  await resolveSalesAdvisorName(
    { dealerId: 11, ownerUserId: 42, assignedTo: "Legacy label" },
    async () => "User #42",
  ),
  "",
  "a users.name User# placeholder is not exposed",
);

assert.equal(
  selectSalesAdvisorName(
    { dealerId: 11, ownerUserId: null, assignedTo: "  Legacy Advisor  " },
    null,
  ),
  "Legacy Advisor",
  "assignedTo is used only for ownerless legacy leads",
);
assert.equal(
  selectSalesAdvisorName(
    { dealerId: 11, ownerUserId: null, assignedTo: null },
    null,
  ),
  "",
  "unassigned leads produce an explicit empty snapshot",
);
assert.equal(
  selectSalesAdvisorName(
    { dealerId: 11, ownerUserId: null, assignedTo: "advisor@example.com" },
    null,
  ),
  "",
  "legacy email placeholders are not customer-facing advisor names",
);
assert.equal(
  selectSalesAdvisorName(
    { dealerId: 11, ownerUserId: null, assignedTo: "User #99" },
    null,
  ),
  "",
  "legacy numeric placeholders are not advisor names",
);

const queuedWithoutOwner = snapshotSalesAdvisorPayload(
  { quoteRef: "EST-00001-R1" },
  "",
);
assert.equal(queuedWithoutOwner.salesAdvisorName, "");
assert.ok(
  Object.prototype.hasOwnProperty.call(queuedWithoutOwner, "salesAdvisorName"),
  "new queues carry an explicit empty advisor snapshot",
);
assert.equal(
  enrichLegacySalesAdvisorPayload(
    { quoteRef: "Q-1-20260924", salesAdvisorName: "" },
    "A later owner",
  ).salesAdvisorName,
  "",
  "replay preserves an intentionally empty snapshot",
);
assert.equal(
  enrichLegacySalesAdvisorPayload(
    { quoteRef: "Q-1-20260924" },
    "Historical Owner",
  ).salesAdvisorName,
  "Historical Owner",
  "older payloads are enriched only when the key is absent",
);

console.log("Sales advisor payload plumbing: 15 assertions passed");
