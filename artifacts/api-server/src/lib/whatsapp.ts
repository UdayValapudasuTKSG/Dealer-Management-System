import twilio from "twilio";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Meta WhatsApp Business Platform (Cloud API) — outbound send helper.
// Sends text, document, reply-button, and interactive-list messages from the
// dealership's WhatsApp number via the Graph API.
// ---------------------------------------------------------------------------

// Overridable for local end-to-end testing against a mock Graph server.
const GRAPH_BASE =
  process.env["WHATSAPP_GRAPH_BASE_URL"] || "https://graph.facebook.com/v21.0";

export type WhatsappProvider = "meta" | "twilio";

export type WhatsappSendResult = {
  providerMessageId: string;
};

export type WhatsappSendFailureDisposition =
  | "retryable_rejection"
  | "terminal_rejection"
  | "uncertain";

export class WhatsappProviderSendError extends Error {
  constructor(
    message: string,
    readonly disposition: WhatsappSendFailureDisposition,
  ) {
    super(message);
    this.name = "WhatsappProviderSendError";
  }
}

export function whatsappSendFailureDisposition(
  error: unknown,
): WhatsappSendFailureDisposition | null {
  return error instanceof WhatsappProviderSendError
    ? error.disposition
    : null;
}

/**
 * Which channel runs the guided lead-capture bot. Explicit WHATSAPP_PROVIDER
 * env wins ("meta" | "twilio"); otherwise auto-detect: Meta when its
 * credentials are configured, else Twilio. The non-selected channel falls
 * back to the legacy one-shot intake so it never goes dead.
 */
export function whatsappProvider(): WhatsappProvider {
  const v = (process.env["WHATSAPP_PROVIDER"] || "").trim().toLowerCase();
  if (v === "twilio") return "twilio";
  if (v === "meta") return "meta";
  return whatsappConfig() ? "meta" : "twilio";
}

export function whatsappConfig(): {
  appSecret: string;
  verifyToken: string;
  accessToken: string;
  phoneNumberId: string;
  dealerId: number;
} | null {
  const appSecret = process.env["META_APP_SECRET"];
  const verifyToken = process.env["META_VERIFY_TOKEN"];
  const accessToken = process.env["WHATSAPP_ACCESS_TOKEN"];
  const phoneNumberId = process.env["WHATSAPP_PHONE_NUMBER_ID"];
  const dealerId = Number(process.env["WHATSAPP_DEALER_ID"]);
  if (
    !appSecret ||
    !verifyToken ||
    !accessToken ||
    !phoneNumberId ||
    !Number.isSafeInteger(dealerId) ||
    dealerId <= 0
  )
    return null;
  return { appSecret, verifyToken, accessToken, phoneNumberId, dealerId };
}

/**
 * Twilio WhatsApp outbound config. Uses TWILIO_WHATSAPP_FROM when set
 * (e.g. the sandbox number), otherwise falls back to TWILIO_PHONE_NUMBER.
 */
export function twilioWhatsappConfig(): {
  accountSid: string;
  authToken: string;
  from: string;
} | null {
  const accountSid = process.env["TWILIO_ACCOUNT_SID"];
  const authToken = process.env["TWILIO_AUTH_TOKEN"];
  const from = (
    process.env["TWILIO_WHATSAPP_FROM"] ||
    process.env["TWILIO_PHONE_NUMBER"] ||
    ""
  ).replace(/[\s()-]/g, "");
  if (!accountSid || !authToken || !from) return null;
  return { accountSid, authToken, from };
}

/** Send a plain WhatsApp text via the Twilio Messages API. */
export async function sendTwilioWhatsappText(
  cfg: { accountSid: string; authToken: string; from: string },
  to: string,
  body: string,
): Promise<void> {
  const client = twilio(cfg.accountSid, cfg.authToken);
  const normalizedTo = to.startsWith("whatsapp:") ? to : `whatsapp:${to}`;
  const normalizedFrom = cfg.from.startsWith("whatsapp:")
    ? cfg.from
    : `whatsapp:${cfg.from}`;
  await client.messages.create({
    from: normalizedFrom,
    to: normalizedTo,
    body,
  });
}

async function send(
  cfg: { accessToken: string; phoneNumberId: string },
  to: string,
  payload: Record<string, unknown>,
  correlationId?: string,
): Promise<WhatsappSendResult> {
  let resp: Response;
  try {
    resp = await fetch(
      `${GRAPH_BASE}/${encodeURIComponent(cfg.phoneNumberId)}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfg.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to,
          ...(correlationId
            ? { biz_opaque_callback_data: correlationId.slice(0, 512) }
            : {}),
          ...payload,
        }),
      },
    );
  } catch {
    throw new WhatsappProviderSendError(
      "WhatsApp provider request outcome is unknown",
      "uncertain",
    );
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    logger.error(
      { status: resp.status, body: text.slice(0, 400), to },
      "WhatsApp send failed",
    );
    const disposition: WhatsappSendFailureDisposition =
      resp.status === 429
        ? "retryable_rejection"
        : resp.status >= 400 && resp.status < 500
          ? "terminal_rejection"
          : "uncertain";
    throw new WhatsappProviderSendError(
      `WhatsApp Graph API ${resp.status}`,
      disposition,
    );
  }
  let data: { messages?: { id?: string }[] };
  try {
    data = (await resp.json()) as { messages?: { id?: string }[] };
  } catch {
    throw new WhatsappProviderSendError(
      "WhatsApp provider response could not be correlated",
      "uncertain",
    );
  }
  const providerMessageId = data.messages?.[0]?.id;
  if (!providerMessageId) {
    throw new WhatsappProviderSendError(
      "WhatsApp Graph API accepted the request without a message id",
      "uncertain",
    );
  }
  return { providerMessageId };
}

export async function sendWhatsappText(
  cfg: { accessToken: string; phoneNumberId: string },
  to: string,
  body: string,
  correlationId?: string,
): Promise<WhatsappSendResult> {
  return send(
    cfg,
    to,
    { type: "text", text: { body, preview_url: false } },
    correlationId,
  );
}

export function whatsappDocumentMessagePayload(opts: {
  mediaId: string;
  filename: string;
  caption?: string;
}): Record<string, unknown> {
  return {
    type: "document",
    document: {
      id: opts.mediaId,
      filename: opts.filename.slice(0, 240),
      ...(opts.caption?.trim()
        ? { caption: opts.caption.trim().slice(0, 1024) }
        : {}),
    },
  };
}

/**
 * Upload a private document to Meta before sending it. A failed upload is
 * always safe to retry because no customer-visible message has been created.
 */
export async function uploadWhatsappDocument(
  cfg: { accessToken: string; phoneNumberId: string },
  opts: { bytes: Uint8Array; filename: string; mimeType: string },
): Promise<string> {
  const form = new FormData();
  const fileBytes = new ArrayBuffer(opts.bytes.byteLength);
  new Uint8Array(fileBytes).set(opts.bytes);
  form.set("messaging_product", "whatsapp");
  form.set(
    "file",
    new Blob([fileBytes], { type: opts.mimeType }),
    opts.filename.slice(0, 240),
  );

  let resp: Response;
  try {
    resp = await fetch(
      `${GRAPH_BASE}/${encodeURIComponent(cfg.phoneNumberId)}/media`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.accessToken}` },
        body: form,
      },
    );
  } catch {
    throw new WhatsappProviderSendError(
      "WhatsApp document upload failed before the customer message was sent",
      "retryable_rejection",
    );
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    logger.error(
      { status: resp.status, body: text.slice(0, 400) },
      "WhatsApp document upload failed",
    );
    throw new WhatsappProviderSendError(
      `WhatsApp media upload API ${resp.status}`,
      resp.status === 429 || resp.status >= 500
        ? "retryable_rejection"
        : "terminal_rejection",
    );
  }

  let data: { id?: string };
  try {
    data = (await resp.json()) as { id?: string };
  } catch {
    throw new WhatsappProviderSendError(
      "WhatsApp document upload response was invalid",
      "retryable_rejection",
    );
  }
  if (!data.id) {
    throw new WhatsappProviderSendError(
      "WhatsApp document upload returned no media id",
      "retryable_rejection",
    );
  }
  return data.id;
}

/** Send a previously uploaded Meta media document to a WhatsApp recipient. */
export async function sendWhatsappDocument(
  cfg: { accessToken: string; phoneNumberId: string },
  to: string,
  opts: { mediaId: string; filename: string; caption?: string },
  correlationId?: string,
): Promise<WhatsappSendResult> {
  return send(
    cfg,
    to,
    whatsappDocumentMessagePayload(opts),
    correlationId,
  );
}

/**
 * Send an approved Meta template. AURA's configured service template must
 * contain one body text variable; the intended message is supplied to it.
 */
export async function sendWhatsappTemplate(
  cfg: { accessToken: string; phoneNumberId: string },
  to: string,
  opts: { name: string; language: string; body: string },
  correlationId?: string,
): Promise<WhatsappSendResult> {
  return send(cfg, to, {
    type: "template",
    template: {
      name: opts.name,
      language: { code: opts.language },
      components: [
        {
          type: "body",
          parameters: [{ type: "text", text: opts.body }],
        },
      ],
    },
  }, correlationId);
}

export type WhatsappButton = { id: string; title: string };

/** Reply-button message (max 3 buttons, titles <= 20 chars). */
export async function sendWhatsappButtons(
  cfg: { accessToken: string; phoneNumberId: string },
  to: string,
  body: string,
  buttons: WhatsappButton[],
  correlationId?: string,
): Promise<WhatsappSendResult> {
  return send(cfg, to, {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body },
      action: {
        buttons: buttons.slice(0, 3).map((b) => ({
          type: "reply",
          reply: { id: b.id, title: b.title.slice(0, 20) },
        })),
      },
    },
  }, correlationId);
}

export type WhatsappListRow = {
  id: string;
  title: string;
  description?: string;
};

/** Channel-agnostic outbound messaging surface for the guided bot. */
export type WhatsappTransport = {
  /** True when the channel supports reply buttons + interactive lists. */
  interactive: boolean;
  /** True when sends are already persisted by the transport itself. */
  durable?: boolean;
  sendText(to: string, body: string): Promise<void>;
  /** Narrow STOP/START acknowledgement path allowed after an opt keyword. */
  sendComplianceText?(to: string, body: string): Promise<void>;
  sendButtons(
    to: string,
    body: string,
    buttons: WhatsappButton[],
  ): Promise<void>;
  sendList(
    to: string,
    opts: {
      body: string;
      buttonLabel: string;
      sectionTitle: string;
      rows: WhatsappListRow[];
    },
  ): Promise<void>;
};

/** Interactive transport over the Meta Cloud (Graph) API. */
export function metaTransport(cfg: {
  accessToken: string;
  phoneNumberId: string;
}): WhatsappTransport {
  return {
    interactive: true,
    sendText: async (to, body) => {
      await sendWhatsappText(cfg, to, body);
    },
    sendComplianceText: async (to, body) => {
      await sendWhatsappText(cfg, to, body);
    },
    sendButtons: async (to, body, buttons) => {
      await sendWhatsappButtons(cfg, to, body, buttons);
    },
    sendList: async (to, opts) => {
      await sendWhatsappList(cfg, to, opts);
    },
  };
}

/**
 * Text-only transport that captures outbound messages so a Twilio webhook
 * can return them as the TwiML reply. The guided bot sends exactly one
 * message per inbound message.
 */
export function captureTransport(): {
  transport: WhatsappTransport;
  messages: string[];
} {
  const messages: string[] = [];
  const push = async (_to: string, body: string): Promise<void> => {
    messages.push(body);
  };
  return {
    messages,
    transport: {
      interactive: false,
      sendText: push,
      sendComplianceText: push,
      // Never called when interactive=false; safe text fallbacks anyway.
      sendButtons: (to, body) => push(to, body),
      sendList: (to, opts) => push(to, opts.body),
    },
  };
}

/** Interactive list message (max 10 rows, titles <= 24 chars). */
export async function sendWhatsappList(
  cfg: { accessToken: string; phoneNumberId: string },
  to: string,
  opts: {
    body: string;
    buttonLabel: string;
    sectionTitle: string;
    rows: WhatsappListRow[];
  },
  correlationId?: string,
): Promise<WhatsappSendResult> {
  return send(cfg, to, {
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: opts.body },
      action: {
        button: opts.buttonLabel.slice(0, 20),
        sections: [
          {
            title: opts.sectionTitle.slice(0, 24),
            rows: opts.rows.slice(0, 10).map((r) => ({
              id: r.id,
              title: r.title.slice(0, 24),
              ...(r.description
                ? { description: r.description.slice(0, 72) }
                : {}),
            })),
          },
        ],
      },
    },
  }, correlationId);
}
