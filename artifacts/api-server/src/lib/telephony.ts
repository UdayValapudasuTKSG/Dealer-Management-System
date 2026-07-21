// ---------------------------------------------------------------------------
// Telephony adapter seam.
//
// Click-to-call flows go through this interface. When the Twilio Voice
// credentials are configured (see twilioVoiceConfig below), advisors dial
// customers straight from the browser via the Twilio Voice JS SDK:
//
//   1. Client asks POST /telephony/token for a short-lived Voice access token.
//   2. Client connects (Device.connect) with { To, LeadId } custom params.
//   3. Twilio hits our TwiML webhook (POST /api/webhooks/twilio/voice) which
//      creates the call_logs row and returns <Dial> to the customer's phone.
//   4. When the dialed leg ends, Twilio hits the action callback
//      (POST /api/webhooks/twilio/voice/complete) which stamps duration +
//      status onto the call log automatically.
//
// Without credentials the stub adapter simply acknowledges the call so staff
// can dial manually and log outcome + sentiment themselves.
// ---------------------------------------------------------------------------
import twilio from "twilio";

export type PlaceCallRequest = {
  dealerId: number;
  leadId: number;
  toPhone: string | null;
  direction: "outbound" | "inbound";
};

export type PlaceCallResult = {
  provider: string;
  providerCallId: string | null;
};

export interface TelephonyAdapter {
  readonly provider: string;
  /** Initiate (or register) a call session. Never throws for the stub. */
  placeCall(req: PlaceCallRequest): Promise<PlaceCallResult>;
}

class StubTelephonyAdapter implements TelephonyAdapter {
  readonly provider = "stub";

  async placeCall(req: PlaceCallRequest): Promise<PlaceCallResult> {
    // No real dial-out. Return a synthetic call id so the call log row
    // carries a traceable reference.
    return {
      provider: this.provider,
      providerCallId: `stub-${req.leadId}-${Date.now()}`,
    };
  }
}

class TwilioTelephonyAdapter implements TelephonyAdapter {
  readonly provider = "twilio";

  async placeCall(req: PlaceCallRequest): Promise<PlaceCallResult> {
    // Browser-initiated calls create their call log in the voice webhook the
    // moment Twilio connects (real CallSid). Manual log entries created via
    // POST /leads/:id/calls carry no live session, so no provider call id.
    return { provider: this.provider, providerCallId: null };
  }
}

export type TwilioVoiceConfig = {
  accountSid: string;
  apiKeySid: string;
  apiKeySecret: string;
  twimlAppSid: string;
  callerId: string;
  authToken: string;
};

/** Twilio Voice browser calling is enabled only when ALL creds are present. */
export function twilioVoiceConfig(): TwilioVoiceConfig | null {
  const accountSid = process.env["TWILIO_ACCOUNT_SID"];
  const apiKeySid = process.env["TWILIO_API_KEY_SID"];
  const apiKeySecret = process.env["TWILIO_API_KEY_SECRET"];
  const twimlAppSid = process.env["TWILIO_TWIML_APP_SID"];
  const callerId = process.env["TWILIO_PHONE_NUMBER"]?.replace(/[\s()-]/g, "");
  const authToken = process.env["TWILIO_AUTH_TOKEN"];
  if (
    !accountSid ||
    !apiKeySid ||
    !apiKeySecret ||
    !twimlAppSid ||
    !callerId ||
    !authToken
  )
    return null;
  return { accountSid, apiKeySid, apiKeySecret, twimlAppSid, callerId, authToken };
}

const TOKEN_TTL_SECONDS = 3600;

/** Mint a short-lived Voice access token for the browser SDK. */
export function createVoiceAccessToken(
  cfg: TwilioVoiceConfig,
  identity: string,
): string {
  const AccessToken = twilio.jwt.AccessToken;
  const token = new AccessToken(cfg.accountSid, cfg.apiKeySid, cfg.apiKeySecret, {
    identity,
    ttl: TOKEN_TTL_SECONDS,
  });
  token.addGrant(
    new AccessToken.VoiceGrant({
      outgoingApplicationSid: cfg.twimlAppSid,
      incomingAllow: false,
    }),
  );
  return token.toJwt();
}

const stub = new StubTelephonyAdapter();
const twilioAdapter = new TwilioTelephonyAdapter();

/** Resolve the active telephony adapter. */
export function telephonyAdapter(): TelephonyAdapter {
  return twilioVoiceConfig() ? twilioAdapter : stub;
}

/** Map a Twilio DialCallStatus onto our call-log status enum. */
export function mapTwilioDialStatus(
  dialStatus: string | undefined,
): "completed" | "no_answer" | "busy" | "voicemail" {
  switch (dialStatus) {
    case "completed":
      return "completed";
    case "answered":
      return "completed";
    case "busy":
      return "busy";
    case "no-answer":
      return "no_answer";
    default:
      // failed / canceled / unknown — nobody was reached.
      return "no_answer";
  }
}
