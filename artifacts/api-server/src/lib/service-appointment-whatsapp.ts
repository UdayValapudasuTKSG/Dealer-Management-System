/**
 * The approved Meta utility template used when staff explicitly press
 * "Remind" for an already-confirmed service appointment.
 *
 * Keep this definition immutable and server-owned.  The template name,
 * language, header, body copy, and variable order must match the Meta
 * approval exactly; allowing a dealer/user supplied template here would make
 * it possible to send the wrong message outside the 24-hour window.
 */
export const SERVICE_APPOINTMENT_CONFIRMED_TEMPLATE = {
  name: "service_appointment_confirmed",
  language: "en",
  header: "Service Appointment Confirmed",
  body:
    "Hi {{1}}, your service appointment at {{2}} is confirmed. Booking reference {{3}}, Service {{4}}, Date {{5}}, Time {{6}}, Vehicle {{7}}, Registration {{8}}. Please arrive 10 minutes before your appointment. Reply to this message if you need assistance or would like to reschedule. Thank you for choosing {{2}}.",
} as const;

export const SERVICE_APPOINTMENT_CONFIRMED_BODY_PARAMETER_COUNT = 8;

export function renderServiceAppointmentConfirmedBody(
  bodyParameters: readonly string[],
): string {
  if (
    bodyParameters.length !==
    SERVICE_APPOINTMENT_CONFIRMED_BODY_PARAMETER_COUNT
  ) {
    throw new Error(
      `service_appointment_confirmed requires exactly ${SERVICE_APPOINTMENT_CONFIRMED_BODY_PARAMETER_COUNT} body parameters`,
    );
  }

  return (
    `Hi ${bodyParameters[0]}, your service appointment at ${bodyParameters[1]} is confirmed. ` +
    `Booking reference ${bodyParameters[2]}, Service ${bodyParameters[3]}, Date ${bodyParameters[4]}, ` +
    `Time ${bodyParameters[5]}, Vehicle ${bodyParameters[6]}, Registration ${bodyParameters[7]}. ` +
    "Please arrive 10 minutes before your appointment. Reply to this message if you need assistance or would like to reschedule. " +
    `Thank you for choosing ${bodyParameters[1]}.`
  );
}