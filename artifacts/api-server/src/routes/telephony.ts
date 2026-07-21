import { Router, type IRouter } from "express";
import {
  GetTelephonyConfigResponse,
  CreateTelephonyTokenResponse,
} from "@workspace/api-zod";
import {
  createVoiceAccessToken,
  twilioVoiceConfig,
} from "../lib/telephony";

const router: IRouter = Router();

// Which provider is live. Browser calling turns on only when the full Twilio
// Voice credential set is configured; otherwise the UI keeps the manual flow.
router.get("/telephony/config", (_req, res): void => {
  const cfg = twilioVoiceConfig();
  res.json(
    GetTelephonyConfigResponse.parse({
      provider: cfg ? "twilio" : "stub",
      browserCallingEnabled: cfg != null,
      callerId: cfg?.callerId ?? null,
    }),
  );
});

// Short-lived Voice access token for the Twilio Voice JS SDK. The identity is
// derived from the signed-in user so Twilio call logs are attributable.
router.post("/telephony/token", (req, res): void => {
  const cfg = twilioVoiceConfig();
  if (!cfg) {
    res.status(503).json({
      error:
        "Browser calling is not configured — add the Twilio Voice credentials to enable it.",
    });
    return;
  }
  const user = res.locals.user as
    | { id?: number; name?: string | null }
    | undefined;
  // Twilio identities must be URL-safe; keep it simple and stable per user.
  const identity = `advisor-${user?.id ?? "unknown"}`;
  try {
    const token = createVoiceAccessToken(cfg, identity);
    res.json(CreateTelephonyTokenResponse.parse({ token, identity }));
  } catch (err) {
    req.log.error({ err }, "Failed to mint Twilio Voice access token");
    res.status(502).json({ error: "Could not create a calling session" });
  }
});

export default router;
