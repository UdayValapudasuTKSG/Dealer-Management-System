export function partsSmsReadiness(dealerId: number, env: Record<string, string | undefined> = process.env) {
  const setupLink = "/parts?tab=operations";
  let settings: unknown;
  try { settings = JSON.parse(env.PARTS_SMS_DEALER_SENDERS ?? "{}"); }
  catch { return { ready: false, enabled: false, sender: null, setupLink, reason: "PARTS_SMS_DEALER_SENDERS is invalid JSON. Ask an administrator to configure dealer SMS." }; }
  const entry = settings && typeof settings === "object" && !Array.isArray(settings) ? (settings as Record<string, unknown>)[String(dealerId)] : undefined;
  const mapping = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
  const sender = typeof mapping.from === "string" && /^\+[1-9]\d{7,14}$/.test(mapping.from) ? mapping.from : null;
  const enabled = mapping.enabled === true;
  const ready = enabled && !!sender && !!env.TWILIO_ACCOUNT_SID && !!env.TWILIO_AUTH_TOKEN;
  return { ready, enabled, sender, setupLink, reason: ready ? null : "SMS not configured for this dealer. Administrator must opt in this dealer in PARTS_SMS_DEALER_SENDERS with an SMS-capable E.164 sender and configure the existing Twilio account credentials. No shared sender fallback is used." };
}