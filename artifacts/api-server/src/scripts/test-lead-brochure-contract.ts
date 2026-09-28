import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { BROCHURE_ATTACHMENT_LIMIT, brochureCatalog, GT_BROCHURES, selectBrochures } from "../lib/lead-brochures";

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
console.log("Seven original PDF digests, catalog validation and attachment caps verified; no mail sent.");