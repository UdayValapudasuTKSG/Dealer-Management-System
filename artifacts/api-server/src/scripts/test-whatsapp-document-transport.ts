import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";

const requests: Array<{
  path: string;
  authorization: string | undefined;
  contentType: string | undefined;
  body: Buffer;
}> = [];

const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks);
  requests.push({
    path: req.url ?? "",
    authorization: req.headers.authorization,
    contentType: req.headers["content-type"],
    body,
  });

  res.setHeader("Content-Type", "application/json");
  if (req.url === "/v21.0/phone-123/media") {
    res.end(JSON.stringify({ id: "media-quote-123" }));
    return;
  }
  if (req.url === "/v21.0/phone-123/messages") {
    res.end(JSON.stringify({ messages: [{ id: "wamid.quote-123" }] }));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(0, "127.0.0.1");
await once(server, "listening");

try {
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  process.env["WHATSAPP_GRAPH_BASE_URL"] =
    `http://127.0.0.1:${address.port}/v21.0`;

  const { sendWhatsappDocument, uploadWhatsappDocument } =
    await import("../lib/whatsapp");
  const cfg = { accessToken: "test-token", phoneNumberId: "phone-123" };
  const mediaId = await uploadWhatsappDocument(cfg, {
    bytes: new TextEncoder().encode("%PDF-1.7\nquote bytes"),
    filename: "AURA-Quote-Q-TEST.pdf",
    mimeType: "application/pdf",
  });
  assert.equal(mediaId, "media-quote-123");

  const result = await sendWhatsappDocument(
    cfg,
    "5926001234",
    {
      mediaId,
      filename: "AURA-Quote-Q-TEST.pdf",
      caption: "Your quote PDF is attached.",
    },
    "aura-outbox:987",
  );
  assert.equal(result.providerMessageId, "wamid.quote-123");
  assert.equal(requests.length, 2);

  const [upload, message] = requests;
  assert.equal(upload!.path, "/v21.0/phone-123/media");
  assert.equal(upload!.authorization, "Bearer test-token");
  assert.match(upload!.contentType ?? "", /^multipart\/form-data; boundary=/);
  assert.match(upload!.body.toString("latin1"), /application\/pdf/);
  assert.match(upload!.body.toString("latin1"), /AURA-Quote-Q-TEST\.pdf/);
  assert.match(upload!.body.toString("latin1"), /%PDF-1\.7/);

  assert.equal(message!.path, "/v21.0/phone-123/messages");
  assert.equal(message!.authorization, "Bearer test-token");
  assert.equal(message!.contentType, "application/json");
  const messageBody = JSON.parse(message!.body.toString("utf8")) as {
    messaging_product: string;
    to: string;
    type: string;
    biz_opaque_callback_data: string;
    document: { id: string; filename: string; caption: string };
  };
  assert.deepEqual(messageBody, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: "5926001234",
    biz_opaque_callback_data: "aura-outbox:987",
    type: "document",
    document: {
      id: "media-quote-123",
      filename: "AURA-Quote-Q-TEST.pdf",
      caption: "Your quote PDF is attached.",
    },
  });

  console.log("WhatsApp document transport: 14 assertions passed");
} finally {
  server.close();
  await once(server, "close");
}