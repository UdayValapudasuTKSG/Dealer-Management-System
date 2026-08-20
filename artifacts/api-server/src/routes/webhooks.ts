import { Router, type IRouter } from "express";
import crypto from "node:crypto";
import { and, eq, inArray, or } from "drizzle-orm";
import {
  db,
  callLogsTable,
  dealersTable,
  leadsTable,
  timelineEventsTable,
  usersTable,
  dealerUsersTable,
  emailLogsTable,
  webhookEventsTable,
  erpnextWebhookEventsTable,
} from "@workspace/db";
import { mapTwilioDialStatus, twilioVoiceConfig } from "../lib/telephony";
import { enqueueWhatsapp, notifyUser } from "../lib/email";
import { logger } from "../lib/logger";
import { autoAnalyzeCall } from "../lib/call-analysis";
import { markLeadContactFromCall } from "../lib/lead-contact";
import { autoTranscribeCall } from "../lib/call-transcription";
import {
  createInboundLead,
  matchVehicleByText,
} from "../lib/lead-intake";
import {
  whatsappConfig,
  type WhatsappTransport,
} from "../lib/whatsapp";
import { getChannelByPhoneNumberId } from "../lib/whatsapp-channel";
import {
  handleWhatsappMessage,
  handleWhatsappOneShot,
  type InboundWhatsappMessage,
} from "../lib/whatsapp-flow";
import {
  allowedWhatsappDeliverySources,
  updateWhatsappDeliveryStatus,
} from "../lib/whatsapp-log";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// ERPNext inbound webhook. ERPNext is configured (per dealer) to POST doc
// events here with the dealer's shared secret in X-AURA-Webhook-Secret.
// Events are recorded, then dispatched to per-DocType handlers (registered
// by the entity-sync tasks; unhandled DocTypes are stored as "skipped").
// Mounted publicly under the rate-limited /webhooks prefix.
// ---------------------------------------------------------------------------

type ErpnextInboundHandler = (event: {
  dealerId: number;
  doctype: string;
  docName: string | null;
  event: string | null;
  payload: Record<string, unknown>;
}) => Promise<void>;

const erpnextInboundHandlers = new Map<string, ErpnextInboundHandler>();

export function registerErpnextInboundHandler(
  doctype: string,
  handler: ErpnextInboundHandler,
): void {
  erpnextInboundHandlers.set(doctype, handler);
}

router.post("/webhooks/erpnext/:dealerId", async (req, res): Promise<void> => {
  const dealerId = Number(req.params["dealerId"]);
  if (!Number.isInteger(dealerId) || dealerId <= 0) {
    res.status(404).json({ error: "Unknown dealer" });
    return;
  }
  const { getErpnextConnection } = await import("../lib/erpnext/connection");
  const conn = await getErpnextConnection(dealerId);
  if (!conn) {
    res.status(404).json({ error: "ERPNext is not configured for this dealer" });
    return;
  }
  const given = req.get("x-aura-webhook-secret") ?? "";
  const a = Buffer.from(conn.webhookSecret, "utf8");
  const b = Buffer.from(given, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    req.log.warn({ dealerId }, "ERPNext webhook rejected: bad shared secret");
    res.status(403).json({ error: "Invalid webhook secret" });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  // ERPNext webhooks send the doc as the JSON body; the DocType/event can be
  // included in the payload template (recommended in our setup guide) or
  // via headers.
  const doctype =
    (typeof body["doctype"] === "string" ? body["doctype"] : null) ??
    req.get("x-frappe-doctype") ??
    null;
  const docName = typeof body["name"] === "string" ? body["name"] : null;
  const event =
    (typeof body["event"] === "string" ? body["event"] : null) ??
    req.get("x-frappe-event") ??
    null;

  const [row] = await db
    .insert(erpnextWebhookEventsTable)
    .values({
      dealerId,
      doctype,
      docName,
      event,
      payload: body,
      status: "received",
    })
    .returning();

  // Acknowledge fast; processing failures are recorded on the event row so
  // ERPNext isn't made to retry (it has no durable retry semantics anyway).
  res.status(200).json({ received: true, eventId: row!.id });

  const handler = doctype ? erpnextInboundHandlers.get(doctype) : undefined;
  try {
    if (handler && doctype) {
      await handler({ dealerId, doctype, docName, event, payload: body });
      await db
        .update(erpnextWebhookEventsTable)
        .set({ status: "processed" })
        .where(eq(erpnextWebhookEventsTable.id, row!.id));
    } else {
      await db
        .update(erpnextWebhookEventsTable)
        .set({ status: "skipped" })
        .where(eq(erpnextWebhookEventsTable.id, row!.id));
    }
  } catch (err) {
    logger.error({ err, dealerId, doctype }, "ERPNext webhook handler failed");
    await db
      .update(erpnextWebhookEventsTable)
      .set({
        status: "error",
        error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
      })
      .where(eq(erpnextWebhookEventsTable.id, row!.id))
      .catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// Meta Lead Ads webhook (Facebook / Instagram lead forms)
// ---------------------------------------------------------------------------

// Overridable so signed webhook flows can be exercised against a local stub
// Graph server in dev/tests (mirrors WHATSAPP_GRAPH_BASE_URL).
const GRAPH_BASE =
  process.env["META_GRAPH_BASE_URL"] || "https://graph.facebook.com/v21.0";

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

/** Resolve the owning dealer from the Meta page id — fail closed when the
 * page is unmapped so a foreign/unknown page can never write a lead. */
async function dealerIdForMetaPage(pageId: string): Promise<number | null> {
  if (!pageId) return null;
  const [d] = await db
    .select({ id: dealersTable.id })
    .from(dealersTable)
    .where(eq(dealersTable.metaPageId, pageId));
  return d?.id ?? null;
}

async function processLeadgenEvent(
  leadgenId: string,
  pageId: string,
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

  // Tenant routing: page_id must map to a dealer BEFORE any write.
  const dealerId = await dealerIdForMetaPage(pageId);
  if (dealerId == null) {
    logger.warn(
      { leadgenId, pageId },
      "Meta leadgen rejected: page_id is not mapped to any dealer",
    );
    return;
  }

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
    entry?: {
      id?: string;
      changes?: {
        field?: string;
        value?: { leadgen_id?: string; page_id?: string };
      }[];
    }[];
  };
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    res.status(400).json({ error: "Invalid JSON" });
    return;
  }

  const leadgenIds: { leadgenId: string; pageId: string }[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const id = change.value?.leadgen_id;
      const pageId = change.value?.page_id ?? entry.id ?? "";
      if (change.field === "leadgen" && id)
        leadgenIds.push({ leadgenId: id, pageId });
    }
  }

  // Acknowledge fast; Meta retries on non-200. Processing errors are logged
  // and the leadgen id stays unprocessed so the retry can succeed.
  res.status(200).json({ received: leadgenIds.length });

  for (const { leadgenId, pageId } of leadgenIds) {
    try {
      await processLeadgenEvent(leadgenId, pageId, cfg.pageToken);
    } catch (err) {
      logger.error({ err, leadgenId }, "Failed to process Meta leadgen event");
    }
  }
});

// ---------------------------------------------------------------------------
// Meta WhatsApp Business Platform (Cloud API) webhook — guided lead-capture
// bot. Parallel first-party channel; the Twilio webhook below stays as-is.
// ---------------------------------------------------------------------------

// Verification handshake — platform-level via global META_VERIFY_TOKEN.
// The platform registers one webhook URL per app, not per dealer.
router.get("/webhooks/whatsapp", (req, res): void => {
  const verifyToken = process.env["META_VERIFY_TOKEN"];
  if (!verifyToken) {
    res.status(503).json({ error: "WhatsApp webhook is not configured" });
    return;
  }
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === verifyToken && typeof challenge === "string") {
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

type WhatsappWebhookStatus = {
  id?: string;
  status?: "sent" | "delivered" | "read" | "failed";
  timestamp?: string;
  biz_opaque_callback_data?: string;
  errors?: {
    code?: number;
    title?: string;
    message?: string;
    error_data?: { details?: string };
  }[];
};

function durableMetaBotTransport(
  dealerId: number,
  inboundMessageId: string,
): WhatsappTransport {
  let sequence = 0;
  const queue = async (
    to: string,
    body: string,
    interactive?: Parameters<typeof enqueueWhatsapp>[0]["interactive"],
    allowOptOutConfirmation = false,
  ): Promise<void> => {
    sequence += 1;
    const row = await enqueueWhatsapp({
      kind: "whatsapp_message",
      to,
      body,
      dealerId,
      actor: "AURA WhatsApp Bot",
      interactive,
      allowOptOutConfirmation,
      dedupeKey: `whatsapp:concierge:${dealerId}:${inboundMessageId}:${sequence}`,
    });
    if (row.status === "cancelled" || row.status === "failed") {
      throw new Error(row.lastError ?? "WhatsApp concierge reply was blocked");
    }
  };
  return {
    interactive: true,
    durable: true,
    sendText: (to, body) => queue(to, body),
    sendComplianceText: (to, body) =>
      queue(to, body, undefined, true),
    sendButtons: (to, body, buttons) =>
      queue(to, body, { type: "buttons", buttons }),
    sendList: (to, opts) =>
      queue(to, opts.body, {
        type: "list",
        buttonLabel: opts.buttonLabel,
        sectionTitle: opts.sectionTitle,
        rows: opts.rows,
      }),
  };
}

// Receiver. Mounted with express.raw() (see app.ts) so the X-Hub-Signature-256
// can be verified over the exact bytes Meta sent.
// Signature verification is platform-level (global META_APP_SECRET).
// Channel resolution is per-dealer via metadata.phone_number_id → DB lookup.
router.post("/webhooks/whatsapp", async (req, res): Promise<void> => {
  const appSecret = process.env["META_APP_SECRET"];
  if (!appSecret) {
    res.status(503).json({ error: "WhatsApp webhook is not configured" });
    return;
  }
  const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
  const signature = req.get("x-hub-signature-256");
  if (!verifyMetaSignature(raw, signature ?? undefined, appSecret)) {
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
          metadata?: {
            display_phone_number?: string;
            phone_number_id?: string;
          };
          messages?: WhatsappWebhookMessage[];
           statuses?: WhatsappWebhookStatus[];
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

  // Acknowledge fast; Meta retries on non-200.
  res.status(200).json({ ok: true });

  // Process each messages change as an independent unit.
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;
      const receivingPhoneNumberId = change.value?.metadata?.phone_number_id;
      if (!receivingPhoneNumberId) continue;

      // Resolve the channel by phoneNumberId — DB first, env fallback.
      const channel = await getChannelByPhoneNumberId(receivingPhoneNumberId);
      if (!channel) {
        req.log.warn(
          { phoneNumberId: receivingPhoneNumberId },
          "Ignoring WhatsApp event for an unknown/disabled phone number",
        );
        continue;
      }

      const contacts = change.value?.contacts ?? [];
      for (const status of change.value?.statuses ?? []) {
        if (!status.id || !status.status) continue;
        const deliveryStatus =
          status.status === "sent" ? "accepted" : status.status;
        const eventKey = `${status.id}:${status.status}:${status.timestamp ?? ""}`;
        try {
          const [seen] = await db
            .select({ id: webhookEventsTable.id })
            .from(webhookEventsTable)
            .where(
              and(
                eq(webhookEventsTable.channel, "meta_whatsapp_status"),
                eq(webhookEventsTable.externalId, eventKey),
              ),
            );
          if (seen) continue;

          const callbackMatch =
            /^aura-outbox:(\d+)$/.exec(
              status.biz_opaque_callback_data ?? "",
            );
          const callbackOutboxId = callbackMatch
            ? Number(callbackMatch[1])
            : null;
          const [outbox] = await db
            .select({
              id: emailLogsTable.id,
              deliveryStatus: emailLogsTable.deliveryStatus,
            })
            .from(emailLogsTable)
            .where(
              and(
                eq(emailLogsTable.dealerId, channel.dealerId),
                eq(emailLogsTable.channel, "whatsapp"),
                callbackOutboxId != null
                  ? or(
                      eq(emailLogsTable.providerMessageId, status.id),
                      eq(emailLogsTable.id, callbackOutboxId),
                    )
                  : eq(emailLogsTable.providerMessageId, status.id),
              ),
            );
          if (!outbox) continue;
          await db.insert(webhookEventsTable).values({
            dealerId: channel.dealerId,
            channel: "meta_whatsapp_status",
            externalId: eventKey,
          });

          const occurredAt =
            status.timestamp && /^\d+$/.test(status.timestamp)
              ? new Date(Number(status.timestamp) * 1000)
              : new Date();
          const providerError = (status.errors ?? [])
            .map(
              (error) =>
                error.error_data?.details ??
                error.message ??
                error.title ??
                (error.code != null ? `Meta error ${error.code}` : ""),
            )
            .filter(Boolean)
            .join("; ")
            .slice(0, 1000);

          const [advanced] = await db
            .update(emailLogsTable)
            .set({
              deliveryStatus,
              providerMessageId: status.id,
              nextAttemptAt: null,
              status: deliveryStatus === "failed" ? "cancelled" : "sent",
              ...(deliveryStatus !== "failed"
                ? { lastError: null, sentAt: occurredAt }
                : {}),
              ...(deliveryStatus === "delivered" || deliveryStatus === "read"
                ? { deliveredAt: occurredAt }
                : {}),
              ...(deliveryStatus === "read" ? { readAt: occurredAt } : {}),
              ...(deliveryStatus === "failed"
                ? {
                    // Provider receipt failures are terminal. Do not put an
                    // accepted send back into the retry queue: doing so could
                    // deliver the same customer message twice.
                    status: "cancelled",
                    lastError:
                      providerError || "Meta reported that delivery failed.",
                  }
                : {}),
            })
            .where(
              and(
                eq(emailLogsTable.id, outbox.id),
                eq(emailLogsTable.dealerId, channel.dealerId),
                inArray(
                  emailLogsTable.deliveryStatus,
                  allowedWhatsappDeliverySources(deliveryStatus),
                ),
              ),
            )
            .returning({ id: emailLogsTable.id });
          if (!advanced) {
            logger.warn(
              {
                providerMessageId: status.id,
                currentStatus: outbox.deliveryStatus,
                incomingStatus: deliveryStatus,
              },
              "Ignored non-monotonic WhatsApp delivery receipt",
            );
            continue;
          }
          await updateWhatsappDeliveryStatus({
            dealerId: channel.dealerId,
            outboxId: outbox.id,
            providerMessageId: status.id,
            status: deliveryStatus,
            error:
              deliveryStatus === "failed"
                ? providerError || "Meta reported that delivery failed."
                : null,
            recordedAt: occurredAt,
          });
        } catch (err) {
          logger.error(
            { err, providerMessageId: status.id, dealerId: channel.dealerId },
            "Failed to process WhatsApp delivery receipt",
          );
        }
      }
      for (const m of change.value?.messages ?? []) {
        if (!m.from || !m.id) continue;
        const messageId = m.id;
        const dealerId = channel.dealerId;
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
            dealerId,
            channel: "meta_whatsapp",
            externalId: messageId,
          });

          const profile =
            contacts.find((c) => c.wa_id === m.from)?.profile?.name ?? "";
          const buttonReply = m.interactive?.button_reply;
          const listReply = m.interactive?.list_reply;
          const reply = listReply ?? buttonReply ?? null;
          const msg: InboundWhatsappMessage = {
            from: m.from,
            profileName: profile,
            text: m.type === "text" ? (m.text?.body ?? "").trim() || null : null,
            replyId: reply?.id ?? null,
            replyTitle: reply?.title ?? null,
          };

          const transport = durableMetaBotTransport(dealerId, messageId);
          await handleWhatsappMessage(transport, msg, dealerId);
        } catch (err) {
          logger.error(
            { err, messageId, dealerId },
            "Failed to process WhatsApp Cloud API message",
          );
        }
      }
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

  // Fail closed. A global Twilio number cannot be attributed to a dealership
  // safely, and TwiML replies bypass the durable, policy-governed Meta outbox.
  // Twilio Voice remains supported below; WhatsApp messaging is Meta-only
  // until Twilio sender numbers have an explicit per-dealer channel mapping.
  req.log.warn(
    { messageSid: params["MessageSid"] ?? params["SmsMessageSid"] ?? null },
    "Twilio WhatsApp inbound ignored: no dealer-safe channel mapping",
  );
  res
    .status(200)
    .type("text/xml")
    .send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
});

// ---------------------------------------------------------------------------
// Twilio Voice webhooks — browser click-to-call.
//
// The TwiML App's Voice Request URL must point at POST /api/webhooks/twilio/voice.
// The Voice JS SDK connects with custom params { To, LeadId }; we create the
// call log row here (status in_progress) and return <Dial> to the customer.
// When the dialed leg ends, Twilio calls the <Dial action> URL and we stamp
// the real duration + outcome onto the same row automatically.
// ---------------------------------------------------------------------------

const escapeXml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function voiceSay(res: Parameters<Parameters<IRouter["post"]>[1]>[1], message: string): void {
  res
    .status(200)
    .type("text/xml")
    .send(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${escapeXml(message)}</Say></Response>`,
    );
}

router.post("/webhooks/twilio/voice", async (req, res): Promise<void> => {
  const cfg = twilioVoiceConfig();
  if (!cfg) {
    res.status(503).json({ error: "Twilio Voice is not configured" });
    return;
  }

  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.body ?? {})) {
    if (typeof v === "string") params[k] = v;
  }
  const signature = req.get("x-twilio-signature");
  if (
    !verifyTwilioSignature(cfg.authToken, publicUrl(req), params, signature ?? undefined)
  ) {
    req.log.warn("Twilio voice webhook rejected: bad signature");
    res.status(403).json({ error: "Invalid signature" });
    return;
  }

  const to = (params["To"] ?? "").trim();
  const leadId = Number(params["LeadId"] ?? "");
  const callSid = params["CallSid"] ?? "";
  // Browser leg arrives as From=client:advisor-<userId> — resolve the name.
  const fromIdentity = params["From"] ?? "";
  const userId = Number(fromIdentity.replace(/^client:advisor-/, ""));

  if (!to || !Number.isFinite(leadId) || leadId <= 0) {
    voiceSay(res, "This call cannot be completed. Missing destination.");
    return;
  }

  try {
    const [lead] = await db
      .select()
      .from(leadsTable)
      .where(eq(leadsTable.id, leadId));
    if (!lead) {
      voiceSay(res, "This call cannot be completed. Lead not found.");
      return;
    }

    // The browser leg identifies the advisor (client:advisor-<userId>) —
    // require a real membership in the lead's dealer before creating the call
    // log, so a signed callback can't attach a call to a foreign tenant.
    let actor = "Staff";
    let member = false;
    if (Number.isFinite(userId) && userId > 0) {
      const [user] = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.id, userId));
      if (user) {
        actor = user.name ?? user.email ?? "Staff";
        const [membership] = await db
          .select({ id: dealerUsersTable.id })
          .from(dealerUsersTable)
          .where(
            and(
              eq(dealerUsersTable.userId, user.id),
              eq(dealerUsersTable.dealerId, lead.dealerId),
            ),
          );
        member = !!membership;
      }
    }
    if (!member) {
      req.log.warn(
        { leadId, userId },
        "Twilio voice webhook rejected: caller is not a member of the lead's dealer",
      );
      voiceSay(res, "This call cannot be completed.");
      return;
    }

    const [call] = await db
      .insert(callLogsTable)
      .values({
        dealerId: lead.dealerId,
        leadId: lead.id,
        direction: "outbound",
        status: "in_progress",
        sentiment: "neutral",
        provider: "twilio",
        providerCallId: callSid || null,
        actor,
      })
      .returning();

    const proto = req.get("x-forwarded-proto")?.split(",")[0]?.trim() || req.protocol;
    const host = req.get("x-forwarded-host")?.split(",")[0]?.trim() || req.get("host");
    const actionUrl = `${proto}://${host}/api/webhooks/twilio/voice/complete?callLogId=${call!.id}`;
    const recordingUrl = `${proto}://${host}/api/webhooks/twilio/voice/recording?callLogId=${call!.id}`;

    res
      .status(200)
      .type("text/xml")
      .send(
        `<?xml version="1.0" encoding="UTF-8"?><Response><Dial callerId="${escapeXml(cfg.callerId)}" action="${escapeXml(actionUrl)}" timeout="25" record="record-from-answer-dual" recordingStatusCallback="${escapeXml(recordingUrl)}" recordingStatusCallbackEvent="completed"><Number>${escapeXml(to)}</Number></Dial></Response>`,
      );
  } catch (err) {
    req.log.error({ err, leadId }, "Failed to start Twilio voice call");
    voiceSay(res, "Sorry, the call could not be connected.");
  }
});

// <Dial action> callback: the dialed leg finished — capture outcome + duration.
router.post(
  "/webhooks/twilio/voice/complete",
  async (req, res): Promise<void> => {
    const cfg = twilioVoiceConfig();
    if (!cfg) {
      res.status(503).json({ error: "Twilio Voice is not configured" });
      return;
    }

    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.body ?? {})) {
      if (typeof v === "string") params[k] = v;
    }
    const signature = req.get("x-twilio-signature");
    if (
      !verifyTwilioSignature(cfg.authToken, publicUrl(req), params, signature ?? undefined)
    ) {
      req.log.warn("Twilio voice completion webhook rejected: bad signature");
      res.status(403).json({ error: "Invalid signature" });
      return;
    }

    const callLogId = Number(req.query["callLogId"] ?? "");
    const callSid = params["CallSid"] ?? "";
    const status = mapTwilioDialStatus(params["DialCallStatus"]);
    const duration = Number(params["DialCallDuration"] ?? "");

    try {
      if (Number.isFinite(callLogId) && callLogId > 0 && callSid) {
        // Bind the update to the immutable Twilio CallSid stamped at call
        // creation — a signed-but-mismatched callback can't touch other rows.
        const [call] = await db
          .update(callLogsTable)
          .set({
            status,
            durationSeconds:
              Number.isFinite(duration) && duration >= 0
                ? Math.round(duration)
                : null,
          })
          .where(
            and(
              eq(callLogsTable.id, callLogId),
              eq(callLogsTable.providerCallId, callSid),
            ),
          )
          .returning();

        // One activity record per call, written once the outcome is known.
        if (call) {
          await markLeadContactFromCall(call);
          const [lead] = await db
            .select()
            .from(leadsTable)
            .where(eq(leadsTable.id, call.leadId));
          if (lead) {
            const mins =
              call.durationSeconds != null
                ? ` (${Math.max(1, Math.round(call.durationSeconds / 60))} min)`
                : "";
            await db.insert(timelineEventsTable).values({
              dealerId: lead.dealerId,
              customerId: lead.customerId,
              domain: "leads",
              kind: "call",
              title: `Outbound call — ${status.replace("_", " ")}${mins}`,
              detail: `Dialed from the browser via Twilio.`,
              actor: call.actor,
              isAgent: false,
              refType: "lead",
              refId: lead.id,
            });

            // Sentiment loop: score the finished call automatically and note
            // the summary on the lead (kill-switch aware, fire-and-forget).
            if (status === "completed") autoAnalyzeCall(call.id);
          }
        }
      }
    } catch (err) {
      req.log.error({ err, callLogId }, "Failed to finalize Twilio voice call");
    }

    // End the parent (browser) leg cleanly.
    res
      .status(200)
      .type("text/xml")
      .send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
  },
);

// Recording status callback: Twilio finished the dual-channel recording of
// the call — stamp the recording onto the call log and kick off AI
// transcription so the full two-party conversation is captured.
router.post(
  "/webhooks/twilio/voice/recording",
  async (req, res): Promise<void> => {
    const cfg = twilioVoiceConfig();
    if (!cfg) {
      res.status(503).json({ error: "Twilio Voice is not configured" });
      return;
    }

    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.body ?? {})) {
      if (typeof v === "string") params[k] = v;
    }
    const signature = req.get("x-twilio-signature");
    if (
      !verifyTwilioSignature(cfg.authToken, publicUrl(req), params, signature ?? undefined)
    ) {
      req.log.warn("Twilio recording webhook rejected: bad signature");
      res.status(403).json({ error: "Invalid signature" });
      return;
    }

    const callLogId = Number(req.query["callLogId"] ?? "");
    const callSid = params["CallSid"] ?? "";
    const recordingSid = params["RecordingSid"] ?? "";
    const recordingStatus = params["RecordingStatus"] ?? "";

    try {
      if (
        Number.isFinite(callLogId) &&
        callLogId > 0 &&
        callSid &&
        recordingSid &&
        recordingStatus === "completed"
      ) {
        // Bind the update to the immutable Twilio CallSid stamped at call
        // creation — a signed-but-mismatched callback can't touch other rows.
        const [call] = await db
          .update(callLogsTable)
          .set({
            recordingSid,
            // Stored for reference; playback goes through our authed proxy
            // (GET /leads/:id/calls/:callId/recording), never this raw URL.
            recordingUrl: params["RecordingUrl"] ?? null,
            transcriptStatus: "pending",
          })
          .where(
            and(
              eq(callLogsTable.id, callLogId),
              eq(callLogsTable.providerCallId, callSid),
            ),
          )
          .returning();
        if (call) {
          req.log.info(
            { callLogId, recordingSid },
            "Twilio recording captured; transcription queued",
          );
          autoTranscribeCall(call.id);
        }
      }
    } catch (err) {
      req.log.error({ err, callLogId }, "Failed to store Twilio recording");
    }

    res.status(200).type("text/xml").send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
  },
);

export default router;
