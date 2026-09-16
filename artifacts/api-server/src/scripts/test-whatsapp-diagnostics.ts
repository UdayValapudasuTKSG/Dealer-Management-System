import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";

const requests: Array<{
  method: string;
  path: string;
  authorization: string | undefined;
}> = [];
let messageAttempt = 0;

const server = createServer(async (req, res) => {
  const path = req.url ?? "";
  requests.push({
    method: req.method ?? "",
    path,
    authorization: req.headers.authorization,
  });
  res.setHeader("Content-Type", "application/json");

  if (path === "/v21.0/phone-123/messages") {
    messageAttempt += 1;
    if (messageAttempt === 1) {
      res.statusCode = 404;
      res.end(
        JSON.stringify({
          error: {
            message:
              "The recipient 5926001234 failed because private details should not be logged",
            type: "OAuthException",
            code: 132001,
            error_subcode: 77,
            fbtrace_id: "AqxgNC0SYRf9RMOktVXSgxi",
          },
        }),
      );
      return;
    }
    if (messageAttempt === 2) {
      res.statusCode = 429;
      res.end(
        JSON.stringify({
          error: {
            message: "rate limited",
            code: 80001,
            fbtrace_id: "rate-limit-trace",
          },
        }),
      );
      return;
    }
    res.statusCode = 500;
    res.end(
      JSON.stringify({
        error: {
          message: "provider temporarily unavailable",
          code: 2,
          fbtrace_id: "temporary-trace",
        },
      }),
    );
    return;
  }

  if (
    req.method === "GET" &&
    path.startsWith("/v21.0/phone-123?fields=")
  ) {
    res.end(
      JSON.stringify({
        verified_name: "Private Sender Name",
        display_phone_number: "+592 600 1234",
        quality_rating: "GREEN",
        platform_type: "CLOUD_API",
        status: "CONNECTED",
      }),
    );
    return;
  }

  if (path === "/v21.0/waba-123/phone_numbers?fields=id&limit=100") {
    res.end(JSON.stringify({ data: [{ id: "phone-123" }] }));
    return;
  }

  if (
    req.method === "GET" &&
    path.startsWith("/v21.0/waba-123/message_templates?")
  ) {
    const query = new URL(`http://localhost${path}`).searchParams;
    assert.equal(query.get("name"), "service_appointment_confirmed");
    assert.equal(query.get("fields"), "name,language,status,components");
    assert.equal(query.get("limit"), "100");
    res.end(
      JSON.stringify({
        data: [
          {
            name: "service_appointment_confirmed",
            language: "en",
            status: "APPROVED",
            components: [
              {
                type: "HEADER",
                format: "TEXT",
                text: "Private Header",
              },
              {
                type: "BODY",
                text:
                  "Hi {{1}}, your service appointment at {{2}} is confirmed.\n\nBooking reference: {{3}}\nService: {{4}}\nDate: {{5}}\nTime: {{6}}\nVehicle: {{7}}\nRegistration: {{8}}\n\nPlease arrive 10 minutes before your appointment. Reply to this message if you need assistance or would like to reschedule.\n\nThank you. We look forward to welcoming you for your vehicle care.",
              },
            ],
          },
        ],
      }),
    );
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: { code: 100, fbtrace_id: "not-found" } }));
});

server.listen(0, "127.0.0.1");
await once(server, "listening");

try {
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  process.env["WHATSAPP_GRAPH_BASE_URL"] =
    `http://127.0.0.1:${address.port}/v21.0`;

  const {
    diagnoseWhatsappChannel,
    isApprovedWhatsappTemplateReady,
    compareWhatsappTemplateStructure,
    parseWhatsappProviderDiagnostics,
    sendWhatsappText,
    whatsappProviderDiagnostics,
    WhatsappProviderSendError,
  } = await import("../lib/whatsapp");
  const {
    SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE,
  } = await import("../lib/service-appointment-whatsapp");

  const cfg = {
    accessToken: "test-token-that-must-never-be-logged",
    phoneNumberId: "phone-123",
  };
  const approvedStructure = {
    approvedBody: SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE.body,
    approvedHeader: SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE.header,
    approvedParameterCount: 8,
    bodyComponentCount: 1,
  };
  assert.deepEqual(
    compareWhatsappTemplateStructure({
      ...approvedStructure,
      body: SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE.body.replace(
        "Hi {{1}},",
        "Hi  {{1}},",
      ),
      header: SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE.header,
    }).bodyDiffCategories,
    ["whitespace"],
  );
  assert.deepEqual(
    compareWhatsappTemplateStructure({
      ...approvedStructure,
      body: SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE.body.replace(
        "confirmed.",
        "confirmed!",
      ),
      header: SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE.header,
    }).bodyDiffCategories,
    ["punctuation"],
  );
  assert.deepEqual(
    compareWhatsappTemplateStructure({
      ...approvedStructure,
      body: SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE.body.replace(
        "Registration: {{8}}",
        "Registration: {{9}}",
      ),
      header: SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE.header,
    }).bodyDiffCategories,
    ["parameter_order"],
  );
  assert.deepEqual(
    compareWhatsappTemplateStructure({
      ...approvedStructure,
      body: SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE.body.replace(
        "Registration: {{8}",
        "Registration",
      ),
      header: null,
    }).bodyDiffCategories,
    ["header_missing", "parameter_count", "parameter_order", "copy"],
  );
  const repeatedParameterRemoved = compareWhatsappTemplateStructure({
    approvedBody: "Hello{{1}}{{1}}world",
    approvedHeader: SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE.header,
    approvedParameterCount: 1,
    body: "Hello{{1}} world",
    bodyComponentCount: 1,
    header: SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE.header,
  });
  assert.deepEqual(repeatedParameterRemoved.actualParameterOccurrences, [
    1,
  ]);
  assert.equal(
    repeatedParameterRemoved.bodyWithoutParametersMatchesApproved,
    true,
  );
  assert.deepEqual(
    repeatedParameterRemoved.bodyWithoutParametersDiffCategories,
    [],
  );
  assert.equal(
    repeatedParameterRemoved.parameterDifference,
    "repeated_parameter_removed",
  );
  const numberingChanged = compareWhatsappTemplateStructure({
    ...approvedStructure,
    body: SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE.body.replace(
      "Registration: {{8}}",
      "Registration: {{9}}",
    ),
    header: SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE.header,
  });
  assert.deepEqual(numberingChanged.actualParameterOccurrences, [
    1, 2, 3, 4, 5, 6, 7, 9,
  ]);
  assert.equal(numberingChanged.bodyWithoutParametersMatchesApproved, true);
  assert.deepEqual(numberingChanged.bodyWithoutParametersDiffCategories, []);
  assert.equal(numberingChanged.parameterDifference, "numbering_only");

  await assert.rejects(
    sendWhatsappText(cfg, "5926001234", "private customer body", "aura-outbox:404"),
    (error: unknown) => {
      if (!(error instanceof WhatsappProviderSendError)) return false;
      assert.equal(error.disposition, "terminal_rejection");
      assert.deepEqual(whatsappProviderDiagnostics(error), {
        httpStatus: 404,
        code: 132001,
        subcode: 77,
        traceId: "AqxgNC0SYRf9RMOktVXSgxi",
        correlationId: "aura-outbox:404",
      });
      assert.doesNotMatch(error.message, /5926001234|private details|customer body/);
      return true;
    },
  );

  await assert.rejects(
    sendWhatsappText(cfg, "5926001234", "private customer body", "aura-outbox:429"),
    (error: unknown) => {
      if (!(error instanceof WhatsappProviderSendError)) return false;
      assert.equal(error.disposition, "retryable_rejection");
      assert.deepEqual(whatsappProviderDiagnostics(error), {
        httpStatus: 429,
        code: 80001,
        subcode: null,
        traceId: "rate-limit-trace",
        correlationId: "aura-outbox:429",
      });
      return true;
    },
  );

  await assert.rejects(
    sendWhatsappText(cfg, "5926001234", "private customer body", "aura-outbox:500"),
    (error: unknown) => {
      if (!(error instanceof WhatsappProviderSendError)) return false;
      assert.equal(error.disposition, "uncertain");
      assert.equal(whatsappProviderDiagnostics(error)?.httpStatus, 500);
      return true;
    },
  );

  assert.deepEqual(
    parseWhatsappProviderDiagnostics(
      {
        error: {
          message: "private message",
          code: 132001,
          error_subcode: 77,
          fbtrace_id: "AqxgNC0SYRf9RMOktVXSgxi",
          recipient: "5926001234",
        },
      },
      404,
      "safe-correlation",
    ),
    {
      httpStatus: 404,
      code: 132001,
      subcode: 77,
      traceId: "AqxgNC0SYRf9RMOktVXSgxi",
      correlationId: "safe-correlation",
    },
  );

  const requestsBeforeDiagnostic = requests.length;
  const diagnostic = await diagnoseWhatsappChannel({
    ...cfg,
    wabaId: "waba-123",
    templateName: SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE.name,
    approvedTemplateLanguage: SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE.language,
    approvedTemplateBody: SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE.body,
    approvedTemplateHeader: SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE.header,
    approvedTemplateParameterCount: 8,
  });
  const diagnosticRequests = requests.slice(requestsBeforeDiagnostic);
  assert.ok(diagnosticRequests.length >= 3);
  assert.ok(diagnosticRequests.every((request) => request.method === "GET"));
  assert.ok(
    diagnosticRequests.every(
      (request) => request.authorization === `Bearer ${cfg.accessToken}`,
    ),
  );
  assert.equal(diagnostic.phone.ok, true);
  assert.equal(diagnostic.phone.status, "CONNECTED");
  assert.equal(diagnostic.phone.platformType, "CLOUD_API");
  assert.equal(diagnostic.waba.ok, true);
  assert.equal(diagnostic.waba.senderMembership, true);
  assert.equal(diagnostic.template?.ok, true);
  assert.deepEqual(diagnostic.template?.templates, [
    {
      httpStatus: 200,
      code: null,
      subcode: null,
      traceId: null,
      language: "en",
      languageMatchesApproved: true,
      status: "APPROVED",
      bodyMatchesApproved: true,
      bodyDiffCategories: ["header_mismatch"],
      expectedParameterCount: 8,
      actualParameterCount: 8,
      expectedParameterOccurrences: [1, 2, 3, 4, 5, 6, 7, 8],
      actualParameterOccurrences: [1, 2, 3, 4, 5, 6, 7, 8],
      expectedParameterOccurrenceCount: 8,
      actualParameterOccurrenceCount: 8,
      bodyWithoutParametersMatchesApproved: true,
      bodyWithoutParametersExactMatchesApproved: true,
      bodyWithoutParametersDiffCategories: [],
      parameterDifference: "none",
      headerMatchesApproved: false,
      bodyComponentCount: 1,
    },
  ]);
  assert.equal(
    isApprovedWhatsappTemplateReady(diagnostic),
    false,
    "an approved name/locale is still not send-ready when its header differs",
  );
  assert.equal(
    isApprovedWhatsappTemplateReady({
      ...diagnostic,
      template: diagnostic.template && {
        ...diagnostic.template,
        templates: diagnostic.template.templates.map((template) => ({
          ...template,
          headerMatchesApproved: true,
        })),
      },
    }),
    true,
    "the readiness gate requires a live approved language, body, and header",
  );
  assert.equal(
    isApprovedWhatsappTemplateReady({
      ...diagnostic,
      template: diagnostic.template && {
        ...diagnostic.template,
        templates: diagnostic.template.templates.map((template) => ({
          ...template,
          headerMatchesApproved: true,
          bodyMatchesApproved: false,
          bodyDiffCategories: ["copy"],
        })),
      },
    }),
    false,
    "an APPROVED locale/header still fails closed for body copy or placeholder-occurrence drift",
  );
  const safeReport = JSON.stringify(diagnostic);
  assert.doesNotMatch(safeReport, /phone-123|waba-123|600 1234|Private Sender|Private Header|\{\{1\}\}/);

  console.log("WhatsApp transport diagnostics: mocked read-only checks passed");
} finally {
  server.close();
  await once(server, "close");
}
