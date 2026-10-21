import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { buildInvoicePdfFromPayload } from "../lib/document-pdfs";
import { COMMERCIAL_DOCUMENT_TERMS, hasCommercialTerms } from "../lib/commercial-document-terms";

const dir = "/tmp/commercial-document-terms";
mkdirSync(dir, { recursive: true });
const base = {
  invoiceNumber: "TEST-TERMS-001", customerName: "Example Customer",
  amount: "500000", kind: "final", issuedAt: "2026-10-21",
  description: "Vehicle sale",
};
for (const [name, extra, expected] of [
  ["estimate", { documentType: "estimate" }, true],
  ["quotation", { documentType: "quotation" }, true],
  ["proforma", { documentType: "proforma" }, true],
  ["predelivery-invoice", { salesTermsApplicable: "true" }, true],
  ["ordinary-invoice", { salesTermsApplicable: "false" }, false],
  ["legacy-unspecified-invoice", {}, false],
  ["long-estimate", { documentType: "estimate", description: Array.from({ length: 60 }, (_, i) => `Item ${i + 1}: documented work and materials`).join("\n") }, true],
] as [string, Record<string, string>, boolean][]) {
  const payload = { ...base, ...extra };
  assert.equal(hasCommercialTerms(payload), expected);
  const path = `${dir}/${name}.pdf`;
  writeFileSync(path, await buildInvoicePdfFromPayload(payload, "America/Guyana", { displayName: "Example Dealership", logo: null }));
  const extracted = JSON.parse(execFileSync("python3", ["-c", `
import fitz,json,sys
d=fitz.open(sys.argv[1])
for p in d:
    for b in p.get_text("blocks"):
        assert b[1]>=0 and b[3]<=p.rect.height, (sys.argv[1],b)
print(json.dumps({"text":" ".join(" ".join(p.get_text().split()) for p in d),"pages":len(d)}))
`, path], { encoding: "utf8" }));
  for (const term of COMMERCIAL_DOCUMENT_TERMS) assert.equal(extracted.text.includes(term), expected, `${name}: ${term}`);
  if (expected) assert.ok(extracted.text.replace(/\s/g, "").includes("TERMSANDCONDITIONS"));
  console.log(`PASS ${name}: ${extracted.pages} page(s), terms ${expected ? "included" : "excluded"}`);
}
