import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  validatedOutboxLeadId,
} from "../lib/email";
import {
  legacyReviewedOutboxDisposition,
  isExplicitLeadOutboxSuppressed,
  suppressesReviewedImportedLead,
} from "../lib/reviewed-delivery-import-policy";

assert.equal(
  suppressesReviewedImportedLead({
    suppressCustomerCommunications: true,
    suppressSalesAutomation: true,
  }),
  true,
);
assert.equal(
  isExplicitLeadOutboxSuppressed(41, {
    suppressCustomerCommunications: true,
    suppressSalesAutomation: true,
  }),
  true,
);
assert.equal(
  isExplicitLeadOutboxSuppressed(null, {
    suppressCustomerCommunications: true,
    suppressSalesAutomation: true,
  }),
  false,
  "provenance policy remains lead-id scoped",
);

const lookups: Array<[number, number]> = [];
assert.equal(
  await validatedOutboxLeadId(
    7,
    null,
    "41",
    async (dealerId, leadId) => {
      lookups.push([dealerId, leadId]);
      return dealerId === 7 ? leadId : null;
    },
  ),
  41,
  "email payload leadId fallback is accepted only through the dealer lookup",
);
assert.deepEqual(lookups, [[7, 41]]);
assert.equal(
  await validatedOutboxLeadId(
    8,
    null,
    "41",
    async () => null,
  ),
  null,
  "a payload lead id not belonging to the dealer is discarded",
);
assert.equal(
  await validatedOutboxLeadId(
    7,
    42,
    "41",
    async (_dealerId, leadId) => leadId,
  ),
  42,
  "the explicit queue lead id takes precedence over payload text",
);

// Dev-only transport seam: model the two queue generations without touching
// email_logs, SMTP, Meta, or a production lead. Explicit reassignment rows are
// suppressed by their imported lead id, while a preexisting no-id row is
// cancelled from the sole imported candidate before the transport boundary.
const importedLead = {
  id: 41,
  ownerUserId: 206,
  importMetadata: {
    suppressCustomerCommunications: true,
    suppressSalesAutomation: true,
    importedAt: "2026-08-01T12:00:00.000Z",
  },
};
const unrelatedSameEmailLead = {
  id: 42,
  ownerUserId: 207,
  importMetadata: null,
};
const sent: string[] = [];
function transportGuard(
  row: {
    leadId: number | null;
    recipient: string;
    template?: string;
    createdAt?: Date;
  },
  candidates: Array<{ id: number; importMetadata: unknown }>,
): "sent" | "cancelled" {
  if (row.leadId != null) {
    const lead = candidates.find((candidate) => candidate.id === row.leadId);
    if (
      lead &&
      isExplicitLeadOutboxSuppressed(lead.id, lead.importMetadata)
    ) {
      return "cancelled";
    }
    sent.push(row.recipient);
    return "sent";
  }
  const legacy = legacyReviewedOutboxDisposition(candidates, {
    template: row.template ?? "vehicle_quote",
    createdAt: row.createdAt ?? new Date("2026-07-31T12:00:00.000Z"),
  });
  if (legacy !== "allow") return "cancelled";
  sent.push(row.recipient);
  return "sent";
}

assert.equal(
  transportGuard(
    {
      // The owner changed, exactly as the manual reassignment route does.
      leadId: importedLead.id,
      recipient: "imported@example.test",
    },
    [importedLead],
  ),
  "cancelled",
  "reassignment of a reviewed imported lead never reaches transport",
);
assert.equal(
  transportGuard(
    { leadId: null, recipient: "imported@example.test" },
    [importedLead],
  ),
  "cancelled",
  "preexisting identity-less queue is cancelled during imported conversion",
);
assert.equal(
  transportGuard(
    { leadId: unrelatedSameEmailLead.id, recipient: "imported@example.test" },
    [importedLead, unrelatedSameEmailLead],
  ),
  "sent",
  "same-email unrelated lead remains deliverable when explicitly identified",
);
assert.equal(
  transportGuard(
    { leadId: null, recipient: "imported@example.test" },
    [importedLead, unrelatedSameEmailLead],
  ),
  "cancelled",
  "ambiguous legacy identity fails closed without suppressing explicit peers",
);
assert.deepEqual(
  sent,
  ["imported@example.test"],
  "only the explicitly identified unrelated lead reached the injected transport",
);

assert.equal(
  transportGuard(
    {
      leadId: null,
      recipient: "imported@example.test",
      template: "service.appointment.reminder",
      createdAt: new Date("2026-07-31T12:00:00.000Z"),
    },
    [importedLead],
  ),
  "sent",
  "service lifecycle rows are never suppressed by legacy recipient matching",
);
assert.equal(
  transportGuard(
    {
      leadId: null,
      recipient: "imported@example.test",
      template: "collision.claim.communication",
      createdAt: new Date("2026-07-31T12:00:00.000Z"),
    },
    [importedLead],
  ),
  "sent",
  "customer-facing collision communication is not misclassified as internal",
);
assert.equal(
  transportGuard(
    {
      leadId: null,
      recipient: "imported@example.test",
      template: "vehicle_quote",
      createdAt: new Date("2026-08-01T12:01:00.000Z"),
    },
    [importedLead],
  ),
  "sent",
  "future sales rows do not inherit pre-import legacy suppression",
);

const emailSource = await readFile(
  new URL("../lib/email.ts", import.meta.url),
  "utf8",
);
const leadsSource = await readFile(
  new URL("../routes/leads.ts", import.meta.url),
  "utf8",
);
const assignmentSource = await readFile(
  new URL("../lib/lead-assignment.ts", import.meta.url),
  "utf8",
);
const testDriveSource = await readFile(
  new URL("../routes/test-drive.ts", import.meta.url),
  "utf8",
);
const importSource = await readFile(
  new URL("../routes/delivery-imports.ts", import.meta.url),
  "utf8",
);
const webhookSource = await readFile(
  new URL("../routes/webhooks.ts", import.meta.url),
  "utf8",
);
assert.match(
  emailSource,
  /enqueueWhatsapp[\s\S]*controlledImportLeadSuppressesEmail/,
  "WhatsApp enqueue checks reviewed-import provenance",
);
assert.match(
  emailSource,
  /const whatsappLeadId = await validatedOutboxLeadId[\s\S]*controlledImportLeadSuppressesEmail/,
  "WhatsApp send rechecks reviewed-import provenance after claim",
);
assert.match(
  emailSource,
  /const emailLeadId = await validatedOutboxLeadId[\s\S]*controlledImportLeadSuppressesEmail/,
  "email send validates payload lead identity before provenance recheck",
);
assert.match(
  emailSource,
  /legacyOutboxReviewDisposition[\s\S]*cancel_ambiguous/,
  "legacy no-id send-time handling fails closed only for ambiguous rows",
);
assert.match(
  leadsSource,
  /template: "vehicle_quote"[\s\S]*leadId: lead\.id/,
  "manual quote email enqueue carries the lead id",
);
assert.match(
  assignmentSource,
  /template: "lead_assignment"[\s\S]*leadId: updated\.id/,
  "auto lead assignment email carries the lead id",
);
assert.match(
  leadsSource,
  /template: "lead_assignment"[\s\S]*leadId: lead!\.id/,
  "manual lead reassignment email carries the lead id",
);
assert.match(
  leadsSource,
  /template: "test_drive_confirmation"[\s\S]*leadId: lead!\.id/,
  "staff test-drive confirmation carries the lead id",
);
assert.match(
  testDriveSource,
  /template: "test_drive_confirmation"[\s\S]*leadId: updated!\.id/,
  "self-service test-drive confirmation carries the lead id",
);
assert.match(
  importSource,
  /isNull\(emailLogsTable\.leadId\)[\s\S]*PRE_IMPORT_SALES_DELIVERY_TEMPLATES[\s\S]*lt\(emailLogsTable\.createdAt, importedAt\)[\s\S]*inArray\(emailLogsTable\.status, \["queued", "processing", "failed"\]\)/,
  "reviewed import conversion only cancels pre-import legacy sales/delivery rows",
);
assert.match(
  webhookSource,
  /enqueueWhatsapp\([\s\S]*allowOptOutConfirmation[\s\S]*dedupeKey/,
  "WhatsApp bot rows remain covered by send-time legacy identity handling",
);

console.log("Reviewed outbox communication policy: scoped legacy assertions passed");