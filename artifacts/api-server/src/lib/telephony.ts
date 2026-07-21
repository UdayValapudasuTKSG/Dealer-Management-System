// ---------------------------------------------------------------------------
// Telephony adapter seam (PENDING-INFRA).
//
// Click-to-call flows go through this interface so a real provider (Twilio
// Voice, Vonage, a local PBX bridge…) can be dropped in later without touching
// route code. Until credentials/infrastructure exist, the stub adapter simply
// acknowledges the call so staff can log outcome + sentiment manually.
// ---------------------------------------------------------------------------

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
    // PENDING-INFRA: no real dial-out. Return a synthetic call id so the
    // call log row carries a traceable reference.
    return {
      provider: this.provider,
      providerCallId: `stub-${req.leadId}-${Date.now()}`,
    };
  }
}

const stub = new StubTelephonyAdapter();

/** Resolve the active telephony adapter. Stub until real infra is wired. */
export function telephonyAdapter(): TelephonyAdapter {
  return stub;
}
