import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  selectQuoteDownloadPayload,
  selectQuoteVersionOutboxPayload,
} from "../lib/quote-payload";
import { enrichLegacySalesAdvisorPayload } from "../lib/sales-advisor";

const queuedSnapshot = {
  total: "GYD 123.00",
  salesAdvisorName: "Historical Advisor",
};
const canonicalSnapshot = {
  total: "GYD 456.00",
  salesAdvisorName: "Current Advisor",
};
const freshInventoryPayload = {
  total: "GYD 789.00",
  salesAdvisorName: "Inventory Advisor",
};

assert.deepEqual(
  selectQuoteDownloadPayload(
    queuedSnapshot,
    canonicalSnapshot,
    freshInventoryPayload,
  ),
  queuedSnapshot,
  "main quote.pdf replay keeps queued amount and advisor snapshot",
);
assert.deepEqual(
  selectQuoteDownloadPayload(null, canonicalSnapshot, freshInventoryPayload),
  canonicalSnapshot,
  "a saved canonical quote beats current inventory when no queue exists",
);
assert.deepEqual(
  selectQuoteDownloadPayload(null, null, freshInventoryPayload),
  freshInventoryPayload,
  "legacy inventory fallback remains available",
);
assert.equal(
  selectQuoteDownloadPayload(null, null, null),
  null,
  "a lead with no queue, quote, or inventory has no payload",
);

const expectedVersion = {
  dealerId: 7,
  leadId: 41,
  quoteId: 501,
  quoteRef: "Q-41-20260801-R2",
};
const oldEmailSnapshot = {
  leadId: "41",
  quoteId: "501",
  quoteRef: expectedVersion.quoteRef,
  total: "GYD 123.00",
  salesAdvisorName: "Advisor Before Reassignment",
};
assert.deepEqual(
  selectQuoteVersionOutboxPayload(
    [
      {
        dealerId: 7,
        leadId: 41,
        channel: "email",
        template: "vehicle_quote",
        payload: oldEmailSnapshot,
      },
    ],
    expectedVersion,
  ),
  oldEmailSnapshot,
  "version download retains a non-empty queued advisor snapshot after reassignment",
);

const emptyAdvisorSnapshot = {
  leadId: "41",
  quoteRef: expectedVersion.quoteRef,
  total: "GYD 123.00",
  salesAdvisorName: "",
};
assert.equal(
  selectQuoteVersionOutboxPayload(
    [
      {
        dealerId: 7,
        leadId: 41,
        channel: "email",
        template: "vehicle_quote",
        payload: emptyAdvisorSnapshot,
      },
    ],
    expectedVersion,
  )?.salesAdvisorName,
  "",
  "version download preserves an intentional empty queued advisor snapshot",
);

const whatsappSnapshot = {
  leadId: "41",
  quoteId: "501",
  quoteRef: expectedVersion.quoteRef,
  total: "GYD 123.00",
  salesAdvisorName: "WhatsApp Historical Advisor",
};
assert.deepEqual(
  selectQuoteVersionOutboxPayload(
    [
      {
        dealerId: 7,
        leadId: 41,
        channel: "whatsapp",
        template: "whatsapp_message",
        payload: {
          documentDataJson: JSON.stringify(whatsappSnapshot),
        },
      },
    ],
    expectedVersion,
  ),
  whatsappSnapshot,
  "version download resolves WhatsApp documentDataJson snapshots",
);

const mismatched = {
  dealerId: 8,
  leadId: 41,
  channel: "email",
  template: "vehicle_quote",
  payload: oldEmailSnapshot,
};
assert.equal(
  selectQuoteVersionOutboxPayload([mismatched], expectedVersion),
  null,
  "version download rejects a mismatched dealer",
);
assert.equal(
  selectQuoteVersionOutboxPayload(
    [{ ...mismatched, dealerId: 7, leadId: 99 }],
    expectedVersion,
  ),
  null,
  "version download rejects a mismatched lead",
);
assert.equal(
  selectQuoteVersionOutboxPayload(
    [
      {
        ...mismatched,
        dealerId: 7,
        payload: { ...oldEmailSnapshot, quoteRef: "Q-41-20260801-R1" },
      },
    ],
    expectedVersion,
  ),
  null,
  "version download rejects a mismatched quote revision",
);
assert.equal(
  enrichLegacySalesAdvisorPayload(
    { total: "GYD 123.00" },
    "Authorized Current Advisor",
  ).salesAdvisorName,
  "Authorized Current Advisor",
  "legacy queued payloads enrich advisor only when the snapshot key is absent",
);
assert.equal(
  enrichLegacySalesAdvisorPayload(
    { total: "GYD 123.00", salesAdvisorName: "" },
    "Current Owner Must Not Replace Empty Snapshot",
  ).salesAdvisorName,
  "",
  "legacy enrichment never replaces an explicit empty advisor snapshot",
);

const leadsSource = await readFile(
  new URL("../routes/leads.ts", import.meta.url),
  "utf8",
);
const enquiriesSource = await readFile(
  new URL("../routes/enquiries.ts", import.meta.url),
  "utf8",
);
const intakeSource = await readFile(
  new URL("../lib/lead-intake.ts", import.meta.url),
  "utf8",
);

assert.match(
  leadsSource,
  /eq\(emailLogsTable\.dealerId, dealerId\)[\s\S]*eq\(emailLogsTable\.leadId, leadId\)/,
  "main quote lookup remains dealer-scoped and uses email_logs.lead_id",
);
assert.match(
  leadsSource,
  /payload\} ->> 'leadId'/,
  "main quote lookup accepts canonical payload lead identity",
);
assert.match(
  leadsSource,
  /queuedQuoteVersionPayload[\s\S]*documentDataJson[\s\S]*selectQuoteVersionOutboxPayload/,
  "version PDF path resolves quote-specific email and WhatsApp snapshots",
);
assert.match(
  leadsSource,
  /const queuedPayload = await queuedQuoteVersionPayload[\s\S]*historicalPayload[\s\S]*quotePdfPayload\(quote, lead\)/,
  "version PDF falls back to the selected historical quote only when no queue exists",
);

for (const [name, source, assignment, quote] of [
  [
    "authenticated lead creation",
    leadsSource,
    "const assigned =",
    "autoQuoteOnLeadCreated(assigned ?? lead)",
  ],
  [
    "public enquiry creation",
    enquiriesSource,
    "const assigned = lead ? await autoAssignLead(lead) : null;",
    "autoQuoteOnLeadCreated(assigned ?? lead)",
  ],
  [
    "inbound intake creation",
    intakeSource,
    "const assigned = await autoAssignLead(lead!);",
    "autoQuoteOnLeadCreated(assigned ?? lead!)",
  ],
] as const) {
  const assignmentIndex = source.indexOf(assignment);
  const quoteIndex = source.indexOf(quote);
  assert.ok(assignmentIndex >= 0, `${name} still assigns the lead`);
  assert.ok(
    quoteIndex > assignmentIndex,
    `${name} assigns ownership before starting quote generation`,
  );
}

console.log("Quote payload/order plumbing: 19 assertions passed");