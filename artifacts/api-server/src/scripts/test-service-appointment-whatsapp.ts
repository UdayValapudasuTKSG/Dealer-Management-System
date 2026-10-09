import assert from "node:assert/strict";
import { leadReportWhatsappTemplate } from "../lib/lead-report-whatsapp";
import { renderEmail } from "../lib/email";
import {
  SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE,
  renderServiceAppointmentConfirmedBody,
  serviceAppointmentVenue,
} from "../lib/service-appointment-whatsapp";
assert.equal(serviceAppointmentVenue("GT Automotive", "220 Camp St, Georgetown"), "GT Automotive — 220 Camp St, Georgetown");
assert.equal(serviceAppointmentVenue("Other Dealer", "Other\n configured address"), "Other Dealer — Other configured address");
assert.equal(serviceAppointmentVenue("Other Dealer", null), "Other Dealer");
for (const template of ["service.appointment.confirmed", "service.appointment.reminder"] as const) {
  const email = renderEmail(template, { location: "220 Camp St, Georgetown", date: "October 10, 2026", time: "9:00 AM" });
  assert.ok(email.html.includes("220 Camp St, Georgetown"));
}
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
assert.deepEqual(leadReportWhatsappTemplate(1, "leads.source.report.daily"), {
  name: "daily_lead_source_report", language: "en_US",
});
assert.equal(leadReportWhatsappTemplate(99, "leads.source.report.daily"), null);
assert.equal(leadReportWhatsappTemplate(1, "feedback.survey"), null);
assert.equal(leadReportWhatsappTemplate(1, "service.appointment.confirmed"), null);
const reportPayload = whatsappTemplateMessagePayload({
  ...leadReportWhatsappTemplate(1, "leads.source.report.daily")!,
  body: "New leads: 24\nContacted: 18",
});
assert.deepEqual(reportPayload, {
  type: "template",
  template: {
    name: "daily_lead_source_report",
    language: { code: "en_US" },
    components: [{ type: "body", parameters: [{ type: "text", text: "New leads: 24 Contacted: 18" }] }],
  },
});
const normalizedPayload = whatsappTemplateMessagePayload({
  name: "aura_service_update",
  language: "en_US",
  body: "Hi Alex,\r\n\r\nPlease\tvisit     https://example.com/feedback/sample\nThank you.",
});
assert.deepEqual(normalizedPayload, {
  type: "template",
  template: {
    name: "aura_service_update",
    language: { code: "en_US" },
    components: [{
      type: "body",
      parameters: [{
        type: "text",
        text: "Hi Alex, Please visit https://example.com/feedback/sample Thank you.",
      }],
    }],
  },
});
const normalizedAppointment = whatsappTemplateMessagePayload({
  name: SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE.name,
  language: "en",
  bodyParameters: bodyParameters.map((text) => `\n${text}\t`),
});
assert.deepEqual(normalizedAppointment, payload);
assert.throws(() => whatsappTemplateMessagePayload({
  name: "aura_service_update", language: "en_US", body: "\n\t    ",
}), /invalid/);
assert.throws(() => whatsappTemplateMessagePayload({
  name: SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE.name, language: "en",
  bodyParameters: ["Alex"],
}), /invalid/);

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