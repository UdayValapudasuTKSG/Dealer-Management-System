import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { BROCHURE_ATTACHMENT_LIMIT, brochureCatalog, GT_BROCHURES, GT_FINANCE, selectBrochures } from "../lib/lead-brochures";
import { renderBrochureFinanceEmail, renderEmail } from "../lib/email";

// Read-only: never imports the outbox worker, opens SMTP, or sends a message.
const assetsDir = resolve(process.cwd(), "../../attached_assets");
const files = readdirSync(assetsDir).filter((name) => /179062380177\d\.pdf$/.test(name));
assert.equal(files.length, 7, "exactly seven uploaded PDFs");
assert.equal(GT_BROCHURES.length, 7);
assert.equal(new Set(GT_BROCHURES.map((b) => b.sha)).size, 7);
for (const brochure of GT_BROCHURES) {
  const file = files.find((name) => {
    const bytes = readFileSync(resolve(assetsDir, name));
    return createHash("sha256").update(bytes).digest("hex") ===
      ("originalSha" in brochure ? brochure.originalSha : brochure.sha);
  });
  assert.ok(file, `original PDF for ${brochure.id} is available`);
  assert.equal(statSync(resolve(assetsDir, file)).size,
    "originalSizeBytes" in brochure ? brochure.originalSizeBytes : brochure.sizeBytes);
}
assert.equal(brochureCatalog.filter((b) => b.sendable).length, 7);
assert.equal(GT_FINANCE["dolphin-mini"]?.downPaymentValue, 150000);
assert.equal(GT_FINANCE["song-pro"]?.monthlyEmi, 69900);
assert.equal(GT_FINANCE["yuan-plus"]?.downPaymentType, "percent");
assert.deepEqual([GT_FINANCE["song-plus-dmi"]?.priceDp, GT_FINANCE["song-plus-dmi"]?.priceDf], [9600000, 7600000]);
assert.deepEqual([GT_FINANCE.shark?.priceDp, GT_FINANCE.shark?.priceDf], [12500000, 10500000]);
assert.equal(GT_FINANCE["atto-8"]?.monthlyEmi, 177920);
assert.equal(GT_FINANCE["sealion-7"], undefined, "never invent Sealion finance");
assert.deepEqual([GT_FINANCE.m9?.downPaymentValue, GT_FINANCE.m9?.monthlyEmi, GT_FINANCE.m9?.priceDp], [10, 177920, 14500000]);
assert.equal(GT_BROCHURES.some((b) => String(b.id) === "m9"), false, "M9 has no PDF in the supplied catalog");
assert.ok(GT_BROCHURES.reduce((sum, b) => sum + b.sizeBytes, 0) < BROCHURE_ATTACHMENT_LIMIT);
const derivative = readFileSync(resolve(process.cwd(), "../../.agents/outputs/BYD-SEALION-7-email.pdf"));
assert.equal(derivative.subarray(0, 4).toString(), "%PDF");
const sealion = GT_BROCHURES.find((b) => b.id === "sealion-7")!;
assert.equal(derivative.length, sealion.sizeBytes);
assert.equal(createHash("sha256").update(derivative).digest("hex"), sealion.sha);
assert.throws(() => selectBrochures(["../../etc/passwd"]), /Unknown brochure/);
assert.throws(() => selectBrochures(["shark", "shark"]), /distinct/);
assert.throws(() => selectBrochures([]), /distinct/);
assert.deepEqual(selectBrochures(["shark", "yuan-plus"]).map((b) => b.id), ["shark", "yuan-plus"]);
assert.equal(selectBrochures(GT_BROCHURES.map((b) => b.id)).length, 7);
const template = renderEmail("lead.brochures", { name: "Test", brochureNames: "Models" }).html;
const offers = [
  ["dolphin-mini", "150,000", "49,900", "4,500,000"],
  ["song-pro", "300,000", "69,900", "5,699,000"],
  ["yuan-plus", "10%", "95,500", "7,500,000"],
  ["song-plus-dmi", "10%", "122,141", "9,600,000", "7,600,000"],
  ["shark", "625,000", "154,900", "12,500,000", "10,500,000"],
  ["atto-8", "10%", "177,920", "14,500,000"],
  ["m9", "10%", "177,920", "14,500,000"],
] as const;
for (const [id, down, emi, priceDp, priceDf] of offers) {
  const value = GT_FINANCE[id];
  const rendered = renderBrochureFinanceEmail(template, JSON.stringify([{ title: `BYD ${value.financeModel}`, ...value }]), undefined);
  for (const content of [rendered.html, rendered.text]) {
    assert.ok(content.includes(down), `${id}: down payment`);
    assert.ok(content.includes(emi), `${id}: EMI`);
    assert.ok(content.includes(priceDp), `${id}: DP price`);
    if (priceDf) assert.ok(content.includes(priceDf), `${id}: DF price`);
    assert.ok(content.includes("https://demerarabank.com/vehicle-loans/"));
    assert.ok(content.includes("bank website"));
  }
}
const queued = { title: "Shark", ...GT_FINANCE.shark };
const immutableSnapshot = JSON.stringify([queued]);
queued.monthlyEmi = 1;
const immutableMail = renderBrochureFinanceEmail(template, immutableSnapshot, undefined);
assert.match(immutableMail.text, /154,900/);
assert.doesNotMatch(immutableMail.text, /Monthly EMI: GYD 1(?:;|\n)/);
const oldSnapshot = renderBrochureFinanceEmail(template, JSON.stringify([{ title: "Old brochure" }]), undefined);
assert.match(oldSnapshot.text, /finance information is not available/);
assert.doesNotMatch(oldSnapshot.text, /Price DP:/);
assert.match(renderBrochureFinanceEmail(template, undefined, "Legacy brochure").html, /Legacy brochure/);
assert.match(renderBrochureFinanceEmail(template, JSON.stringify([{ title: "<script>alert(1)</script>" }]), undefined).html, /&lt;script&gt;/);
assert.doesNotMatch(renderBrochureFinanceEmail(template, JSON.stringify([{ title: "<script>" }]), undefined).html, /<script>/);
console.log("Seven original PDF digests, finance HTML/plain text and immutable snapshots verified; no mail sent.");