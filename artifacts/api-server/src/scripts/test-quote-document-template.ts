import assert from "node:assert/strict";
import { quoteDocumentWhatsappTemplate, quoteDocumentTemplateParameters } from "../lib/quote-document-whatsapp";
import { whatsappTemplateMessagePayload, sendWhatsappTemplate } from "../lib/whatsapp";

const template = quoteDocumentWhatsappTemplate(1)!;
assert.deepEqual(template, { name: "vehicle_estimate_document", language: "en_US" });
assert.equal(quoteDocumentWhatsappTemplate(99), null);
assert.equal(quoteDocumentWhatsappTemplate(2), null);
assert.throws(() => quoteDocumentTemplateParameters({ name: "Alex" }));
assert.throws(() => quoteDocumentTemplateParameters({ name: " ", quoteRef: "EST-1" }));
const opts = {
  ...template,
  bodyParameters: quoteDocumentTemplateParameters({ name: "Alex\n Mensah", quoteRef: "EST-00070-R2" }),
  document: { mediaId: "private-media-id", filename: "EST-00070-R2.pdf" },
};
const payload = whatsappTemplateMessagePayload(opts);
assert.deepEqual(payload, {
  type: "template",
  template: {
    name: "vehicle_estimate_document", language: { code: "en_US" },
    components: [
      { type: "header", parameters: [{ type: "document", document: { id: "private-media-id", filename: "EST-00070-R2.pdf" } }] },
      { type: "body", parameters: [{ type: "text", text: "Alex Mensah" }, { type: "text", text: "EST-00070-R2" }] },
    ],
  },
});
const original = globalThis.fetch;
let sent: Record<string, unknown> | undefined;
globalThis.fetch = async (_url, init) => {
  sent = JSON.parse(String(init?.body));
  return new Response(JSON.stringify({ messages: [{ id: "wamid.quote-test" }] }), {
    status: 200, headers: { "content-type": "application/json" },
  });
};
try {
  const result = await sendWhatsappTemplate(
    { accessToken: "mock", phoneNumberId: "mock" }, "5926001234", opts, "aura-outbox:test",
  );
  assert.equal(result.providerMessageId, "wamid.quote-test");
  assert.deepEqual(sent?.template, payload.template);
} finally {
  globalThis.fetch = original;
}
console.log("GT quote document template contract passed; mocked transport, no real send.");
