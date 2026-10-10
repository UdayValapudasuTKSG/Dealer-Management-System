import assert from "node:assert/strict";
import { quoteDocumentTemplate, quoteDocumentTemplateParameters } from "../lib/quote-document-template";
import { whatsappTemplateMessagePayload, sendWhatsappTemplate } from "../lib/whatsapp";

const template = quoteDocumentTemplate(1)!;
assert.deepEqual(template, { name: "vehicle_estimate_document", language: "en_US" });
assert.equal(quoteDocumentTemplate(99), null);
const bodyParameters = quoteDocumentTemplateParameters({ name: "Alex\nCustomer", quoteRef: "EST-00070-R2" });
assert.throws(() => quoteDocumentTemplateParameters({ name: "Alex" }));
const opts = { ...template, bodyParameters, documentHeader: { mediaId: "media-test", filename: "EST-00070-R2.pdf" } };
const payload = whatsappTemplateMessagePayload(opts);
assert.deepEqual(payload, {
  type: "template",
  template: {
    name: "vehicle_estimate_document",
    language: { code: "en_US" },
    components: [
      { type: "header", parameters: [{ type: "document", document: { id: "media-test", filename: "EST-00070-R2.pdf" } }] },
      { type: "body", parameters: [{ type: "text", text: "Alex Customer" }, { type: "text", text: "EST-00070-R2" }] },
    ],
  },
});
assert.throws(() => whatsappTemplateMessagePayload({ ...opts, documentHeader: { mediaId: "", filename: "x.pdf" } }));
const original = globalThis.fetch;
let sent = false;
globalThis.fetch = async (_url, init) => {
  sent = true;
  const request = JSON.parse(String(init?.body));
  assert.equal(request.type, "template");
  assert.deepEqual(request.template, (payload as { template: unknown }).template);
  assert.equal(request.biz_opaque_callback_data, "aura-outbox:test");
  return new Response(JSON.stringify({ messages: [{ id: "wamid.mock" }] }), { status: 200 });
};
try {
  await sendWhatsappTemplate({ accessToken: "mock", phoneNumberId: "mock" }, "5926000000", opts, "aura-outbox:test");
  assert.ok(sent);
} finally {
  globalThis.fetch = original;
}
console.log("Quote document template contract passed (mock transport; no messages sent).");
