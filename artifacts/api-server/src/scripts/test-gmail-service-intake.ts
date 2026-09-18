import assert from "node:assert/strict";
import {
  isServiceBookingSubject,
  parseServiceBookingForm,
  runAtomicInboundDeliveryOnce,
} from "../lib/gmail-service-intake";
import {
  parseServiceInboxRequests,
  resolveServiceInboxes,
  serviceInboxSearch,
  shouldFetchServiceSource,
  type ServiceInboxCredentialRow,
} from "../lib/gmail-service-mailboxes";

const forwardedText = `---------- Forwarded message ---------
From: website-relay@example.invalid
Subject: Website Contact Form | Book Your Service Online

Name: Priya Customer
Email: Priya.Customer@example.com
Phone: +592 (600) 1234
Model: Toyota RAV4
Preferred Date: September 11, 2026
Wait for or drop off vehicle?: Wait for vehicle
Select one or more services below: Air conditioner`;

const parsedText = parseServiceBookingForm({ text: forwardedText });
assert.deepEqual(parsedText.issues, []);
assert.equal(parsedText.name, "Priya Customer");
assert.equal(parsedText.email, "priya.customer@example.com");
assert.equal(parsedText.phone, "+5926001234");
assert.equal(parsedText.preferredDate, "2026-09-11");
assert.equal(parsedText.services, "Air conditioner");
assert.equal(parsedText.waitOrDropoff, "Wait for vehicle");

const parsedHtml = parseServiceBookingForm({
  text: "relay@example.invalid",
  html: `<table>
    <tr><th>Name</th><td>Priya Customer</td></tr>
    <tr><th>Email</th><td>priya.customer@example.com</td></tr>
    <tr><th>Phone</th><td>592-600-1234</td></tr>
    <tr><th>Model</th><td>Toyota RAV4</td></tr>
    <tr><th>Preferred Date</th><td>September 11, 2026</td></tr>
    <tr><th>Wait for or drop off vehicle?</th><td>Drop off vehicle</td></tr>
    <tr><th>Select one or more services below</th><td>Air conditioner</td></tr>
  </table>`,
});
assert.deepEqual(parsedHtml.issues, []);
assert.equal(parsedHtml.phone, "5926001234");
assert.equal(parsedHtml.preferredDate, "2026-09-11");
assert.equal(parsedHtml.waitOrDropoff, "Drop off vehicle");

for (const subject of [
  "[EXTERNAL]Fwd: Website Contact Form | Book Your Service Online",
  "Re: website contact form | BOOK YOUR SERVICE ONLINE",
  "Fwd: [EXTERNAL] Website Contact Form | Book Your Service Online",
]) {
  assert.equal(isServiceBookingSubject(subject), true);
}

const invalid = parseServiceBookingForm({
  text: `From: relay@example.invalid
Name: Customer
Email: not-an-email
Phone: 123
Model:
Preferred Date: September 31, 2026`,
});
assert.ok(invalid.issues.length >= 4);
assert.equal(invalid.name, "Customer");
assert.equal(invalid.email, null);
assert.equal(invalid.phone, null);
assert.equal(invalid.model, null);
assert.equal(invalid.preferredDate, null);

// Functional fake-DB regression for the same unique-ledger contract used by
// Gmail intake: concurrent/repeated deliveries create one booking and trigger
// one post-commit notification. No database or mailbox is touched.
let claimed = false;
let created = 0;
let notifications = 0;
const deliver = async () => {
  const booking = await runAtomicInboundDeliveryOnce(
    async () => {
      if (claimed) return null;
      claimed = true;
      return "ledger-row";
    },
    async () => {
      created += 1;
      return { id: created };
    },
  );
  if (booking) notifications += 1;
  return booking;
};
const concurrent = await Promise.all([deliver(), deliver(), deliver()]);
assert.equal(concurrent.filter(Boolean).length, 1);
assert.equal(created, 1);
assert.equal(notifications, 1);

// Ledger ownership includes the configured dealer scope: an identical
// Message-ID delivered through two configured dealer mailboxes must not fold
// into the other dealer's booking.
const dealerClaims = new Set<string>();
let dealerBookings = 0;
const deliverForDealer = async (dealerId: number) =>
  runAtomicInboundDeliveryOnce(
    async () => {
      const key = `${dealerId}:same-message-id`;
      if (dealerClaims.has(key)) return null;
      dealerClaims.add(key);
      return key;
    },
    async () => {
      dealerBookings += 1;
      return dealerBookings;
    },
  );
assert.equal(await deliverForDealer(101), 1);
assert.equal(await deliverForDealer(202), 2);
assert.equal(await deliverForDealer(101), null);

// A failed transaction does not retain its ledger claim, so a later delivery
// may retry the failed write; once committed, later deliveries are no-ops.
claimed = false;
await assert.rejects(
  runAtomicInboundDeliveryOnce(
    async () => {
      claimed = true;
      return "rolled-back-ledger";
    },
    async () => {
      claimed = false;
      throw new Error("simulated booking write failure");
    },
  ),
);
assert.equal(claimed, false);
assert.deepEqual(
  await runAtomicInboundDeliveryOnce(
    async () => {
      if (claimed) return null;
      claimed = true;
      return "committed-ledger";
    },
    async () => ({ id: 1 }),
  ),
  { id: 1 },
);

// Explicit dealer inbox configuration is non-secret, strict, and scoped only
// to listed dealer IDs. The fake rows stand in for saved smtp_connections.
const now = new Date("2026-09-18T17:00:00.000Z");
const rows = new Map<number, ServiceInboxCredentialRow>([
  [
    99,
    {
      dealerId: 99,
      dealerStatus: "active",
      host: "smtp.gmail.com",
      username: " No-Reply@CamMotors.gy ",
      enabled: true,
      passwordCiphertext: "saved-ciphertext",
    },
  ],
  [
    100,
    {
      dealerId: 100,
      dealerStatus: "active",
      host: "mail.example.com",
      username: "service@example.com",
      enabled: true,
      passwordCiphertext: "saved-ciphertext",
    },
  ],
  [
    101,
    {
      dealerId: 101,
      dealerStatus: "active",
      host: "smtp.gmail.com",
      username: "paused@gmail.com",
      enabled: false,
      passwordCiphertext: "saved-ciphertext",
    },
  ],
]);
const loaded: number[] = [];
const resolved = await resolveServiceInboxes({
  raw: JSON.stringify([
    { dealerId: 99, initialSince: "2026-09-18T16:40:00.000Z" },
    { dealerId: 100 },
    { dealerId: 101 },
  ]),
  legacyMailboxes: ["salesadmin@example.com"],
  now,
  loadCredential: async (dealerId) => {
    loaded.push(dealerId);
    return rows.get(dealerId) ?? null;
  },
  decrypt: (_ciphertext, dealerId) => `decrypted-for-${dealerId}`,
});
assert.deepEqual(loaded, [99, 100, 101]); // no unlisted SMTP discovery
assert.equal(resolved.inboxes.length, 1);
assert.equal(resolved.inboxes[0]!.dealerId, 99);
assert.equal(resolved.inboxes[0]!.user, "no-reply@cammotors.gy");
assert.equal(resolved.inboxes[0]!.pass, "decrypted-for-99");
assert.equal(
  resolved.inboxes[0]!.initialSince.toISOString(),
  "2026-09-18T16:40:00.000Z",
);
assert.ok(resolved.inboxes[0]!.markerId.includes(":99:"));
assert.ok(resolved.inboxes[0]!.ledgerPrefix.includes(":99:"));
assert.deepEqual(
  resolved.issues.map((issue) => issue.code),
  ["not_gmail", "disabled"],
);

// Seen status is intentionally absent for recovery; metadata gates source
// reads by watermark, ledger and service subject.
assert.deepEqual(serviceInboxSearch(now), { since: now });
assert.equal(
  shouldFetchServiceSource({
    subject: "Website Contact Form | Book Your Service Online",
    internalDate: now,
    since: now,
    alreadyProcessed: false,
  }),
  true,
);
assert.equal(
  shouldFetchServiceSource({
    subject: "Website Contact Form | Book Your Service Online",
    internalDate: new Date("2026-09-18T16:59:59.999Z"),
    since: now,
    alreadyProcessed: false,
  }),
  false,
);
assert.equal(
  shouldFetchServiceSource({
    subject: "Quote request",
    since: now,
    alreadyProcessed: false,
  }),
  false,
);
assert.equal(
  shouldFetchServiceSource({
    subject: "Website Contact Form | Book Your Service Online",
    since: now,
    alreadyProcessed: true,
  }),
  false,
);

// Legacy mailbox ownership conflicts fail closed, as do inactive dealers,
// bad/future watermarks and duplicate dealer entries.
const conflict = await resolveServiceInboxes({
  raw: JSON.stringify([{ dealerId: 99 }]),
  legacyMailboxes: ["NO-REPLY@CAMMOTORS.GY"],
  now,
  loadCredential: async () => rows.get(99)!,
  decrypt: () => "unused",
});
assert.equal(conflict.inboxes.length, 0);
assert.equal(conflict.issues[0]!.code, "ownership_conflict");
const invalidConfig = parseServiceInboxRequests(
  JSON.stringify([
    { dealerId: 98, initialSince: "2026-09-18T17:00:00Z" },
    { dealerId: 99 },
    { dealerId: 99 },
    { dealerId: 102, initialSince: "2026-09-19T00:00:00.000Z" },
  ]),
  now,
);
assert.equal(invalidConfig.requests.length, 1);
assert.deepEqual(
  invalidConfig.issues.map((issue) => issue.code),
  ["invalid_config", "duplicate_dealer", "invalid_config"],
);
const inactive = await resolveServiceInboxes({
  raw: JSON.stringify([{ dealerId: 99 }]),
  legacyMailboxes: [],
  now,
  loadCredential: async () => ({ ...rows.get(99)!, dealerStatus: "suspended" }),
  decrypt: () => "unused",
});
assert.equal(inactive.issues[0]!.code, "dealer_inactive");

// Stable dealer+mailbox identities preserve marker/dedupe keys across runs,
// while the same mailbox assigned to another dealer cannot share its ledger.
const again = await resolveServiceInboxes({
  raw: JSON.stringify([{ dealerId: 99 }]),
  legacyMailboxes: [],
  now,
  loadCredential: async () => rows.get(99)!,
  decrypt: () => "password",
});
assert.equal(again.inboxes[0]!.identity, resolved.inboxes[0]!.identity);
const otherDealer = await resolveServiceInboxes({
  raw: JSON.stringify([{ dealerId: 199 }]),
  legacyMailboxes: [],
  now,
  loadCredential: async () => ({ ...rows.get(99)!, dealerId: 199 }),
  decrypt: () => "password",
});
assert.notEqual(otherDealer.inboxes[0]!.ledgerPrefix, again.inboxes[0]!.ledgerPrefix);

console.log("Gmail service intake parser checks passed");