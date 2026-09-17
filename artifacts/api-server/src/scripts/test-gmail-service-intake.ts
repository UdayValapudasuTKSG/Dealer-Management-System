import assert from "node:assert/strict";
import {
  isServiceBookingSubject,
  parseServiceBookingForm,
  runAtomicInboundDeliveryOnce,
} from "../lib/gmail-service-intake";

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

console.log("Gmail service intake parser checks passed");