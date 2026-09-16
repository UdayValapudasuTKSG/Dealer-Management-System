import assert from "node:assert/strict";
import {
  SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE,
  renderServiceAppointmentConfirmedBody,
} from "../lib/service-appointment-whatsapp";
import {
  sendWhatsappTemplate,
  whatsappTemplateMessagePayload,
} from "../lib/whatsapp";

const bodyParameters = [
  "Alex Mensah",
  "Main Service Centre",
  "RO-00042",
  "maintenance",
  "August 14, 2026",
  "9:00 AM",
  "2025 BYD Seal",
  "PXX 1234",
] as const;

assert.equal(SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE.name, "service_appointment_confirmed");
assert.equal(SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE.language, "en");
assert.equal(SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE.header, "Service Appointment Confirmed");
assert.equal(bodyParameters.length, 8);

const body = renderServiceAppointmentConfirmedBody(bodyParameters);
assert.equal(
  body,
  "Hi Alex Mensah, your service appointment at Main Service Centre is confirmed.\n\nBooking reference: RO-00042\nService: maintenance\nDate: August 14, 2026\nTime: 9:00 AM\nVehicle: 2025 BYD Seal\nRegistration: PXX 1234\n\nPlease arrive 10 minutes before your appointment. Reply to this message if you need assistance or would like to reschedule.\n\nThank you. We look forward to welcoming you for your vehicle care.",
);

const payload = whatsappTemplateMessagePayload({
  name: SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE.name,
  language: SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE.language,
  bodyParameters,
});
assert.deepEqual(payload, {
  type: "template",
  template: {
    name: "service_appointment_confirmed",
      language: { code: "en" },
    components: [
      {
        type: "body",
        parameters: bodyParameters.map((text) => ({ type: "text", text })),
      },
    ],
  },
});

const originalFetch = globalThis.fetch;
let requestBody: Record<string, unknown> | null = null;
globalThis.fetch = async (_input, init) => {
  requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
  return new Response(JSON.stringify({ messages: [{ id: "wamid.mock" }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
try {
  const result = await sendWhatsappTemplate(
    { accessToken: "mock-token", phoneNumberId: "mock-phone-number-id" },
    "5926001234",
    {
      name: SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE.name,
      language: SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE.language,
      bodyParameters,
    },
  );
  assert.equal(result.providerMessageId, "wamid.mock");
  assert.ok(requestBody);
  assert.deepEqual(
    (requestBody as { template?: unknown }).template,
    payload.template,
  );
} finally {
  globalThis.fetch = originalFetch;
}

console.log("Service appointment WhatsApp template contract passed (mock transport only).");