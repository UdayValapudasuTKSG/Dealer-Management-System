import { Router, type IRouter } from "express";
import crypto from "node:crypto";
import { and, eq, notInArray, isNotNull } from "drizzle-orm";
import {
  db,
  leadsTable,
  timelineEventsTable,
  webhookEventsTable,
} from "@workspace/db";
import { notifyUser } from "../lib/email";
import { logger } from "../lib/logger";
import {
  createInboundLead,
  matchVehicleByText,
} from "../lib/lead-intake";
import { defaultDealerId } from "../lib/tenancy";
import {
  captureTransport,
  metaTransport,
  whatsappConfig,
  whatsappProvider,
} from "../lib/whatsapp";
import {
  handleWhatsappMessage,
  handleWhatsappOneShot,
  type InboundWhatsappMessage,
} from "../lib/whatsapp-flow";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Meta Lead Ads webhook (Facebook / Instagram lead forms)
// ---------------------------------------------------------------------------

const GRAPH_BASE = "https://graph.facebook.com/v21.0";

function metaConfig(): {
  appSecret: string;
  pageToken: string;
  verifyToken: string;
} | null {
  const appSecret = process.env["META_APP_SECRET"];
  const pageToken = process.env["META_PAGE_ACCESS_TOKEN"];
  const verifyToken = process.env["META_VERIFY_TOKEN"];
  if (!appSecret || !pageToken || !verifyToken) return null;
  return { appSecret, pageToken, verifyToken };
}

// Verification handshake: Meta calls GET with hub.mode/hub.verify_token and
// expects the raw hub.challenge echoed back.
router.get("/webhooks/meta", (req, res): void => {
  const cfg = metaConfig();
  if (!cfg) {
    res.status(503).json({ error: "Meta webhook is not configured" });
    return;
  }
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === cfg.verifyToken && typeof challenge === "string") {
    res.status(200).type("text/plain").send(challenge);
    return;
  }
  res.status(403).json({ error: "Verification failed" });
});

function verifyMetaSignature(
  rawBody: Buffer,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = crypto
    .createHmac("sha256", appSecret)
    .update(rawBody)
    .digest("hex");
  const given = header.slice("sha256=".length);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(given, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

type MetaFieldDatum = { name: string; values?: string[] };

async function processLeadgenEvent(
  leadgenId: string,
  pageToken: string,
): Promise<void> {
  // Idempotency: skip leadgen ids we've already processed (Meta retries).
  const [seen] = await db
    .select()
    .from(webhookEventsTable)
    .where(
      and(
        eq(webhookEventsTable.channel, "meta_leadgen"),
        eq(webhookEventsTable.externalId, leadgenId),
      ),
    );
  if (seen) return;

  const url = `${GRAPH_BASE}/${encodeURIComponent(leadgenId)}?fields=field_data,created_time,platform,form_id&access_token=${encodeURIComponent(pageToken)}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Graph API ${resp.status}: ${text.slice(0, 300)}`);
  }
  const data = (await resp.json()) as {
    field_data?: MetaFieldDatum[];
    platform?: string;
  };

  const fields = new Map<string, string>();
  for (const f of data.field_data ?? []) {
    const v = f.values?.[0];
    if (v != null && v !== "") fields.set(f.name.toLowerCase(), v);
  }
  const pick = (...names: string[]): string | null => {
    for (const n of names) {
      const v = fields.get(n);
      if (v) return v;
    }
    return null;
  };

  const first = pick("first_name");
  const last = pick("last_name");
  const name =
    pick("full_name", "name") ??
    [first, last].filter(Boolean).join(" ").trim() ??
    "";
  const email = pick("email", "email_address", "work_email");
  const phone = pick("phone_number", "phone", "mobile_number", "whatsapp_number");

  // Any custom question mentioning a vehicle/car/model is treated as the
  // vehicle-interest answer and matched against inventory.
  let vehicleAnswer: string | null = null;
  for (const [key, value] of fields) {
    if (/vehicle|car|model|interested/.test(key)) {
      vehicleAnswer = value;
      break;
    }
  }
  const dealerId = await defaultDealerId();
  const vehicle = await matchVehicleByText(vehicleAnswer, dealerId);

  const source = data.platform === "ig" ? "instagram" : "facebook";
  const channelLabel = source === "instagram" ? "Instagram Lead Ad" : "Facebook Lead Ad";

  const noteParts: string[] = [];
  if (vehicleAnswer && !vehicle) noteParts.push(`Enquired about: ${vehicleAnswer}`);
  noteParts.push(`Captured from a Meta lead form (lead ${leadgenId}).`);

  const lead = await createInboundLead({
    dealerId,
    name: name || "Meta lead",
    email,
    phone,
    channel: "social",
    source,
    notes: noteParts.join("\n"),
    vehicle,
    channelLabel,
    actor: "Meta Lead Ads",
  });

  await db.insert(webhookEventsTable).values({
    channel: "meta_leadgen",
    externalId: leadgenId,
    leadId: lead.id,
  });
}

// Receiver. Mounted with express.raw() (see app.ts) so the signature can be
// verified over the exact bytes Meta sent.
router.post("/webhooks/meta", async (req, res): Promise<void> => {
  const cfg = metaConfig();
  if (!cfg) {
    res.status(503).json({ error: "Meta webhook is not configured" });
    return;
  }
  const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
  const signature = req.get("x-hub-signature-256");
  if (!verifyMetaSignature(raw, signature ?? undefined, cfg.appSecret)) {
    req.log.warn("Meta webhook rejected: bad signature");
    res.status(403).json({ error: "Invalid signature" });
    return;
  }

  let payload: {
    object?: string;
    entry?: { changes?: { field?: string; value?: { leadgen_id?: string } }[] }[];
  };
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    res.status(400).json({ error: "Invalid JSON" });
    return;
  }

  const leadgenIds: string[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const id = change.value?.leadgen_id;
      if (change.field === "leadgen" && id) leadgenIds.push(id);
    }
  }

  // Acknowledge fast; Meta retries on non-200. Processing errors are logged
  // and the leadgen id stays unprocessed so the retry can succeed.
  res.status(200).json({ received: leadgenIds.length });

  for (const id of leadgenIds) {
    try {
      await processLeadgenEvent(id, cfg.pageToken);
    } catch (err) {
      logger.error({ err, leadgenId: id }, "Failed to process Meta leadgen event");
    }
  }
});

// ---------------------------------------------------------------------------
// Meta WhatsApp Business Platform (Cloud API) webhook — guided lead-capture
// bot. Parallel first-party channel; the Twilio webhook below stays as-is.
// ---------------------------------------------------------------------------

// Verification handshake (same contract as the Lead Ads webhook).
router.get("/webhooks/whatsapp", (req, res): void => {
  const cfg = whatsappConfig();
  if (!cfg) {
    res.status(503).json({ error: "WhatsApp webhook is not configured" });
    return;
  }
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === cfg.verifyToken && typeof challenge === "string") {
    res.status(200).type("text/plain").send(challenge);
    return;
  }
  res.status(403).json({ error: "Verification failed" });
});

type WhatsappWebhookMessage = {
  id?: string;
  from?: string;
  type?: string;
  text?: { body?: string };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string };
  };
  button?: { text?: string };
};

// Receiver. Mounted with express.raw() (see app.ts) so the X-Hub-Signature-256
// can be verified over the exact bytes Meta sent.
router.post("/webhooks/whatsapp", async (req, res): Promise<void> => {
  const cfg = whatsappConfig();
  if (!cfg) {
    res.status(503).json({ error: "WhatsApp webhook is not configured" });
    return;
  }
  const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
  const signature = req.get("x-hub-signature-256");
  if (!verifyMetaSignature(raw, signature ?? undefined, cfg.appSecret)) {
    req.log.warn("WhatsApp webhook rejected: bad signature");
    res.status(403).json({ error: "Invalid signature" });
    return;
  }

  let payload: {
    object?: string;
    entry?: {
      changes?: {
        field?: string;
        value?: {
          messages?: WhatsappWebhookMessage[];
          contacts?: { wa_id?: string; profile?: { name?: string } }[];
        };
      }[];
    }[];
  };
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    res.status(400).json({ error: "Invalid JSON" });
    return;
  }

  const inbound: InboundWhatsappMessage[] = [];
  const messageIds: string[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;
      const contacts = change.value?.contacts ?? [];
      for (const m of change.value?.messages ?? []) {
        if (!m.from || !m.id) continue;
        const profile =
          contacts.find((c) => c.wa_id === m.from)?.profile?.name ?? "";
        const buttonReply = m.interactive?.button_reply;
        const listReply = m.interactive?.list_reply;
        const reply = listReply ?? buttonReply ?? null;
        inbound.push({
          from: m.from,
          profileName: profile,
          text: m.type === "text" ? (m.text?.body ?? "").trim() || null : null,
          replyId: reply?.id ?? null,
          replyTitle: reply?.title ?? null,
        });
        messageIds.push(m.id);
      }
    }
  }

  // Acknowledge fast; Meta retries on non-200.
  res.status(200).json({ received: inbound.length });

  for (let i = 0; i < inbound.length; i++) {
    const msg = inbound[i]!;
    const messageId = messageIds[i]!;
    try {
      // Idempotency: Meta redelivers on timeout/retry.
      const [seen] = await db
        .select()
        .from(webhookEventsTable)
        .where(
          and(
            eq(webhookEventsTable.channel, "meta_whatsapp"),
            eq(webhookEventsTable.externalId, messageId),
          ),
        );
      if (seen) continue;
      await db.insert(webhookEventsTable).values({
        channel: "meta_whatsapp",
        externalId: messageId,
      });
      const transport = metaTransport(cfg);
      if (whatsappProvider() === "meta") {
        await handleWhatsappMessage(transport, msg);
      } else {
        // Twilio is the guided-bot provider; Meta falls back to one-shot intake.
        await handleWhatsappOneShot(transport, msg);
      }
    } catch (err) {
      logger.error(
        { err, messageId },
        "Failed to process WhatsApp Cloud API message",
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Twilio WhatsApp inbound-message webhook
// ---------------------------------------------------------------------------

function twilioAuthToken(): string | null {
  return process.env["TWILIO_AUTH_TOKEN"] || null;
}

/** Twilio signature: base64(HMAC-SHA1(authToken, url + sorted(key+value))). */
function verifyTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signature: string | undefined,
): boolean {
  if (!signature) return false;
  let data = url;
  for (const key of Object.keys(params).sort()) {
    data += key + params[key];
  }
  const expected = crypto
    .createHmac("sha1", authToken)
    .update(Buffer.from(data, "utf8"))
    .digest("base64");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function publicUrl(req: {
  protocol: string;
  originalUrl: string;
  get(name: string): string | undefined;
}): string {
  const proto = req.get("x-forwarded-proto")?.split(",")[0]?.trim() || req.protocol;
  const host = req.get("x-forwarded-host")?.split(",")[0]?.trim() || req.get("host");
  return `${proto}://${host}${req.originalUrl}`;
}

const digits = (s: string): string => s.replace(/\D/g, "");

const OPEN_EXCLUDED_PHASES = ["won", "lost"];

router.post("/webhooks/twilio/whatsapp", async (req, res): Promise<void> => {
  const authToken = twilioAuthToken();
  if (!authToken) {
    res.status(503).json({ error: "Twilio webhook is not configured" });
    return;
  }

  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.body ?? {})) {
    if (typeof v === "string") params[k] = v;
  }
  const signature = req.get("x-twilio-signature");
  if (!verifyTwilioSignature(authToken, publicUrl(req), params, signature ?? undefined)) {
    req.log.warn("Twilio webhook rejected: bad signature");
    res.status(403).json({ error: "Invalid signature" });
    return;
  }

  const from = params["From"] ?? ""; // "whatsapp:+15551234567"
  const phone = from.replace(/^whatsapp:/i, "").trim();
  const profileName = params["ProfileName"]?.trim() || "";
  const body = (params["Body"] ?? "").trim();
  const messageSid = params["MessageSid"] ?? params["SmsMessageSid"] ?? "";

  const twiml = (message: string): void => {
    res
      .status(200)
      .type("text/xml")
      .send(
        `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${message
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")}</Message></Response>`,
      );
  };

  if (!phone) {
    res.status(400).json({ error: "Missing sender" });
    return;
  }

  try {
    // Idempotency: Twilio can redeliver the same MessageSid.
    if (messageSid) {
      const [seen] = await db
        .select()
        .from(webhookEventsTable)
        .where(
          and(
            eq(webhookEventsTable.channel, "twilio_whatsapp"),
            eq(webhookEventsTable.externalId, messageSid),
          ),
        );
      if (seen) {
        res.status(200).type("text/xml").send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
        return;
      }
    }

    const dealerId = await defaultDealerId();

    // Guided-bot mode: when Twilio is the selected WhatsApp provider, the
    // shared conversation engine drives the reply (numbered text menus in
    // place of Meta's interactive buttons/lists), returned as TwiML.
    if (whatsappProvider() === "twilio") {
      const { transport, messages } = captureTransport();
      await handleWhatsappMessage(transport, {
        from: digits(phone),
        profileName,
        text: body || null,
        replyId: null,
        replyTitle: null,
      });
      if (messageSid) {
        await db.insert(webhookEventsTable).values({
          channel: "twilio_whatsapp",
          externalId: messageSid,
        });
      }
      twiml(
        messages.length
          ? messages.join("\n\n")
          : "Thank you for contacting AURA Motors. One of our advisors will be in touch shortly.",
      );
      return;
    }

    // Legacy one-shot intake (Meta is the guided-bot provider).
    // Dedupe against open leads by phone number (digit-suffix match).
    const needle = digits(phone);
    const candidates = await db
      .select()
      .from(leadsTable)
      .where(
        and(
          eq(leadsTable.dealerId, dealerId),
          isNotNull(leadsTable.phone),
          notInArray(leadsTable.phase, OPEN_EXCLUDED_PHASES),
        ),
      );
    const existing = candidates.find((l) => {
      const d = digits(l.phone ?? "");
      if (!d || !needle) return false;
      const a = d.slice(-10);
      const b = needle.slice(-10);
      return a === b || d === needle;
    });

    let leadId: number;
    if (existing) {
      leadId = existing.id;
      await db.insert(timelineEventsTable).values({
        dealerId: existing.dealerId,
        customerId: existing.customerId,
        domain: "leads",
        kind: "whatsapp_message",
        title: `WhatsApp message from ${existing.name}`,
        detail: body || "(no text)",
        actor: "WhatsApp",
        isAgent: true,
        refType: "lead",
        refId: existing.id,
      });
      if (existing.ownerUserId) {
        await notifyUser({
          userId: existing.ownerUserId,
          dealerId: existing.dealerId,
          type: "system",
          title: `WhatsApp: ${existing.name}`,
          body: body ? body.slice(0, 180) : "New WhatsApp message received.",
          link: "/pipeline",
        });
      }
    } else {
      const noteParts: string[] = [];
      if (body) noteParts.push(`WhatsApp message: ${body}`);
      const lead = await createInboundLead({
        dealerId,
        name: profileName || `WhatsApp ${phone}`,
        phone,
        channel: "social",
        source: "whatsapp",
        notes: noteParts.length ? noteParts.join("\n") : null,
        vehicle: await matchVehicleByText(body, dealerId),
        channelLabel: "WhatsApp",
        actor: "WhatsApp",
      });
      leadId = lead.id;
    }

    if (messageSid) {
      await db.insert(webhookEventsTable).values({
        channel: "twilio_whatsapp",
        externalId: messageSid,
        leadId,
      });
    }

    twiml(
      existing
        ? "Thanks — your message has been added to your file. Your advisor will follow up shortly."
        : "Thank you for contacting AURA Motors. We've received your message and one of our advisors will be in touch shortly.",
    );
  } catch (err) {
    req.log.error({ err }, "Failed to process WhatsApp message");
    res.status(500).json({ error: "Failed to process message" });
  }
});

export default router;
