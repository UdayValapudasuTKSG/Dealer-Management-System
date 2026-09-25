import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { exactPoMail, arrivalFailureStatus } from "./po-delivery-policy";
test("provider mock receives exact edited content and exact immutable PDF bytes", async () => {
  const pdf = Buffer.from("%PDF-1.4\nisolated-test-only");
  const final = { to_address: "supplier@example.invalid", cc: "reviewer@example.invalid", subject: "Edited final subject", body_html: "<p>Edited & final body</p>", filename: "purchase-order-test.pdf", sha256: createHash("sha256").update(pdf).digest("hex") };
  let calls = 0;
  const provider = { async sendMail(payload: ReturnType<typeof exactPoMail>) { calls++; assert.equal(payload.html, final.body_html); assert.equal(payload.subject, final.subject); assert.equal(payload.to, final.to_address); assert.equal(payload.cc, final.cc); assert.deepEqual(payload.attachments[0].content, pdf); return { messageId: "mock-provider-id" }; } };
  assert.equal((await provider.sendMail(exactPoMail(final, pdf))).messageId, "mock-provider-id");
  assert.equal(calls, 1);
  assert.throws(() => exactPoMail(final, Buffer.from("changed PDF")), /integrity/);
  assert.throws(() => exactPoMail({ ...final, subject: "Bad\r\nBcc: injected" }, pdf), /header/);
});
test("failed SMS retries at most three times; uncertain acceptance never retries", () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(n => arrivalFailureStatus(n, false, "sms")), ["pending", "pending", "pending", "failed", "failed"]);
  assert.equal(arrivalFailureStatus(1, true, "sms"), "sending");
  assert.equal(arrivalFailureStatus(1, false, "email"), "failed");
});