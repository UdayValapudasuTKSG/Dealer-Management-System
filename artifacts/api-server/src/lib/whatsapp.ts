import twilio from "twilio";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Meta WhatsApp Business Platform (Cloud API) — outbound send helper.
// Sends text, reply-button, and interactive-list messages from the
// dealership's WhatsApp number via the Graph API.
// ---------------------------------------------------------------------------

// Overridable for local end-to-end testing against a mock Graph server.
const GRAPH_BASE =
  process.env["WHATSAPP_GRAPH_BASE_URL"] || "https://graph.facebook.com/v21.0";

export type WhatsappProvider = "meta" | "twilio";

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
): Promise<void> {
  const resp = await fetch(
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
        ...payload,
      }),
    },
  );
  if (!resp.ok) {
    const text = await resp.text();
    logger.error(
      { status: resp.status, body: text.slice(0, 400), to },
      "WhatsApp send failed",
    );
    throw new Error(`WhatsApp Graph API ${resp.status}`);
  }
}

export async function sendWhatsappText(
  cfg: { accessToken: string; phoneNumberId: string },
  to: string,
  body: string,
): Promise<void> {
  await send(cfg, to, { type: "text", text: { body, preview_url: false } });
}

export type WhatsappButton = { id: string; title: string };

/** Reply-button message (max 3 buttons, titles <= 20 chars). */
export async function sendWhatsappButtons(
  cfg: { accessToken: string; phoneNumberId: string },
  to: string,
  body: string,
  buttons: WhatsappButton[],
): Promise<void> {
  await send(cfg, to, {
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
  });
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
  sendText(to: string, body: string): Promise<void>;
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
    sendText: (to, body) => sendWhatsappText(cfg, to, body),
    sendButtons: (to, body, buttons) =>
      sendWhatsappButtons(cfg, to, body, buttons),
    sendList: (to, opts) => sendWhatsappList(cfg, to, opts),
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
): Promise<void> {
  await send(cfg, to, {
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
  });
}
