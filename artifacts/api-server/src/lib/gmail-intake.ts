import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { and, eq, notInArray, isNotNull } from "drizzle-orm";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import {
  db,
  leadsTable,
  timelineEventsTable,
  webhookEventsTable,
} from "@workspace/db";
import { notifyUser, notifyUsers, SYSTEM_MAIL_HEADER } from "./email";
import { createInboundLead, matchVehicleByText } from "./lead-intake";
import { defaultDealerId, dealerStaffIdsByRole } from "./tenancy";
import { logger } from "./logger";
import {
  confidenceGateReason,
  guardUntrusted,
  isAgentEnabled,
  recordAgentRun,
} from "./agent-governance";

// ---------------------------------------------------------------------------
// Gmail email-to-lead intake agent.
//
// Polls the dealership Gmail inbox over plain IMAP (imap.gmail.com, TLS) using
// the GMAIL_USER / GMAIL_APP_PASSWORD env vars — deliberately NOT the Replit
// Gmail connector, so the integration survives a migration off Replit.
//
// Each unseen email is: deduped by Message-ID (webhook_events ledger, channel
// "gmail_email"), classified by the AI (sales enquiry vs. not), and — when it
// is an enquiry — turned into a lead through the shared inbound intake path
// (auto-assignment, quote/welcome email, coordinator notifications, timeline).
// Repeat senders with an open lead get a timeline note instead of a duplicate.
// Processed mail is marked \Seen and copied to the "AURA/Processed" label.
//
// Failures never crash the server: every poll is wrapped, and missing/broken
// credentials just log and leave the agent idle until the next tick.
// ---------------------------------------------------------------------------

const CHANNEL = "gmail_email";
const MARKER_CHANNEL = "gmail_intake";
const MARKER_ID = "enabled_at";
const PROCESSED_MAILBOX = "AURA/Processed";
const POLL_MS = 2 * 60 * 1000;

function gmailConfig(): { user: string; pass: string } | null {
  const user = process.env["GMAIL_USER"];
  const pass = process.env["GMAIL_APP_PASSWORD"];
  if (!user || !pass) return null;
  return { user, pass };
}

// ---------------------------------------------------------------------------
// Enable-time watermark — only mail arriving after the feature went live is
// processed (no historical backfill). Persisted in webhook_events so it
// survives restarts.
// ---------------------------------------------------------------------------

let enabledAtCache: Date | null = null;

async function enabledAt(): Promise<Date> {
  if (enabledAtCache) return enabledAtCache;
  const [row] = await db
    .select()
    .from(webhookEventsTable)
    .where(
      and(
        eq(webhookEventsTable.channel, MARKER_CHANNEL),
        eq(webhookEventsTable.externalId, MARKER_ID),
      ),
    );
  if (row) {
    enabledAtCache = row.createdAt;
    return row.createdAt;
  }
  const [inserted] = await db
    .insert(webhookEventsTable)
    .values({ channel: MARKER_CHANNEL, externalId: MARKER_ID })
    .onConflictDoNothing()
    .returning();
  enabledAtCache = inserted?.createdAt ?? new Date();
  return enabledAtCache;
}

async function alreadyProcessed(messageId: string): Promise<boolean> {
  const [seen] = await db
    .select({ id: webhookEventsTable.id })
    .from(webhookEventsTable)
    .where(
      and(
        eq(webhookEventsTable.channel, CHANNEL),
        eq(webhookEventsTable.externalId, messageId),
      ),
    );
  return !!seen;
}

async function recordProcessed(
  messageId: string,
  leadId: number | null,
): Promise<void> {
  await db
    .insert(webhookEventsTable)
    .values({ channel: CHANNEL, externalId: messageId, leadId })
    .onConflictDoNothing();
}

// ---------------------------------------------------------------------------
// AI classification & extraction
// ---------------------------------------------------------------------------

type Extraction = {
  isEnquiry: boolean;
  confidence: number | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  vehicle: string | null;
  summary: string | null;
};

async function classifyEmail(input: {
  fromName: string;
  fromEmail: string;
  subject: string;
  body: string;
}): Promise<Extraction> {
  const prompt = `You are the email-intake agent for AURA Motors, a car dealership.
Classify the email below and extract enquiry details.

An email is a SALES ENQUIRY when a real person is asking about buying,
viewing, test-driving, pricing, financing, or availability of a vehicle.
This INCLUDES automated website-form notifications that relay a customer's
enquiry (e.g. "Quote request" emails containing structured fields like
First Name / Phone / Email / Vehicle) — for those, extract the CUSTOMER's
details from the body, not the sender of the notification.
Newsletters, marketing blasts, payment/bank receipts, spam, job
applications, and supplier/internal mail are NOT enquiries.

From: ${input.fromName} <${input.fromEmail}>
Subject: ${input.subject}
Body:
${guardUntrusted("email_body", input.body)}

Respond with ONLY a JSON object, no markdown fences:
{"isEnquiry": boolean, "confidence": number (0 to 1 — how sure you are about this classification and the extracted details), "name": string|null (the customer's name), "email": string|null (the customer's email address if stated in the body, else null), "phone": string|null (phone number mentioned in the body), "vehicle": string|null (the vehicle they mention, e.g. "BMW X5"), "summary": string|null (1-2 sentence summary of what they want)}`;

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 400,
    messages: [{ role: "user", content: prompt }],
  });
  const text = message.content
    .filter((b) => b.type === "text")
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim()
    .replace(/^```(?:json)?/, "")
    .replace(/```$/, "")
    .trim();
  const parsed = JSON.parse(text) as Partial<Extraction>;
  return {
    isEnquiry: parsed.isEnquiry === true,
    confidence:
      typeof parsed.confidence === "number" &&
      parsed.confidence >= 0 &&
      parsed.confidence <= 1
        ? parsed.confidence
        : null,
    name: typeof parsed.name === "string" ? parsed.name : null,
    email:
      typeof parsed.email === "string" && parsed.email.includes("@")
        ? parsed.email.trim()
        : null,
    phone: typeof parsed.phone === "string" ? parsed.phone : null,
    vehicle: typeof parsed.vehicle === "string" ? parsed.vehicle : null,
    summary: typeof parsed.summary === "string" ? parsed.summary : null,
  };
}

// ---------------------------------------------------------------------------
// Lead creation / repeat-sender dedup
// ---------------------------------------------------------------------------

const OPEN_EXCLUDED_PHASES = ["won", "lost"];

async function findOpenLeadByEmail(dealerId: number, email: string) {
  const candidates = await db
    .select()
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.dealerId, dealerId),
        isNotNull(leadsTable.email),
        notInArray(leadsTable.phase, OPEN_EXCLUDED_PHASES),
      ),
    );
  const needle = email.trim().toLowerCase();
  return candidates.find((l) => (l.email ?? "").trim().toLowerCase() === needle);
}

async function handleEnquiry(opts: {
  fromName: string;
  fromEmail: string;
  subject: string;
  body: string;
  extraction: Extraction;
}): Promise<number | null> {
  const dealerId = await defaultDealerId();
  // Prefer the customer's email extracted from the body (website-form
  // notifications relay the enquiry — the SMTP sender is just the relay).
  const contactEmail = opts.extraction.email || opts.fromEmail;
  // Self-lead edge: when the sender is the monitored inbox itself (self-sent
  // test/enquiry mail), repeat self-sends fold into the first open self-lead
  // via this email lookup — same behavior as any repeat sender. Acceptable:
  // self-sent mail is a testing/notes-to-self path, not distinct customers.
  const existing = await findOpenLeadByEmail(dealerId, contactEmail);
  if (existing) {
    await db.insert(timelineEventsTable).values({
      dealerId: existing.dealerId,
      customerId: existing.customerId,
      domain: "leads",
      kind: "email_message",
      title: `Email from ${existing.name}`,
      detail: `Subject: ${opts.subject || "(no subject)"}\n${opts.body.slice(0, 1500) || "(no text)"}`,
      actor: "AURA Email Agent",
      isAgent: true,
      refType: "lead",
      refId: existing.id,
    });
    if (existing.ownerUserId) {
      await notifyUser({
        userId: existing.ownerUserId,
        dealerId: existing.dealerId,
        type: "system",
        title: `Email: ${existing.name}`,
        body: (opts.extraction.summary || opts.subject || "New email received.").slice(0, 180),
        link: `/lead/${existing.id}`,
      });
    }
    return existing.id;
  }

  const vehicle = await matchVehicleByText(opts.extraction.vehicle, dealerId);
  const noteParts: string[] = [];
  if (opts.extraction.summary) noteParts.push(opts.extraction.summary);
  if (opts.extraction.vehicle && !vehicle)
    noteParts.push(`Enquired about: ${opts.extraction.vehicle}`);
  noteParts.push(
    `Email subject: ${opts.subject || "(no subject)"}`,
    `Email body:\n${opts.body.slice(0, 2000) || "(no text)"}`,
  );

  const lead = await createInboundLead({
    dealerId,
    name: opts.extraction.name || opts.fromName || contactEmail,
    email: contactEmail,
    phone: opts.extraction.phone,
    channel: "email",
    source: "gmail",
    notes: noteParts.join("\n\n"),
    vehicle,
    channelLabel: "Email",
    actor: "AURA Email Agent",
  });
  return lead.id;
}

// ---------------------------------------------------------------------------
// IMAP polling
// ---------------------------------------------------------------------------

async function ensureProcessedMailbox(client: ImapFlow): Promise<boolean> {
  try {
    await client.mailboxCreate(PROCESSED_MAILBOX);
    return true;
  } catch (err) {
    // ALREADYEXISTS is expected after the first run.
    const code = (err as { serverResponseCode?: string }).serverResponseCode;
    if (code === "ALREADYEXISTS") return true;
    const text = (err as { responseText?: string }).responseText ?? "";
    if (/exists/i.test(text)) return true;
    logger.warn({ err }, "Gmail intake: could not create processed mailbox");
    return false;
  }
}

async function markHandled(
  client: ImapFlow,
  uid: number,
  hasProcessedBox: boolean,
): Promise<void> {
  try {
    await client.messageFlagsAdd({ uid: String(uid) }, ["\\Seen"], { uid: true });
    if (hasProcessedBox) {
      await client.messageCopy({ uid: String(uid) }, PROCESSED_MAILBOX, { uid: true });
    }
  } catch (err) {
    logger.warn({ err, uid }, "Gmail intake: failed to mark message handled");
  }
}

let polling = false;
let credWarned = false;

export async function pollGmailInbox(): Promise<void> {
  if (polling) return;
  const cfg = gmailConfig();
  if (!cfg) {
    if (!credWarned) {
      logger.warn(
        "Gmail intake: GMAIL_USER / GMAIL_APP_PASSWORD not set — email-to-lead agent is idle",
      );
      credWarned = true;
    }
    return;
  }
  // Kill switch: dealer paused the email intake agent — skip polling entirely.
  if (!(await isAgentEnabled(await defaultDealerId(), "sales"))) return;
  polling = true;
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
  });

  try {
    const since = await enabledAt();
    await client.connect();
    const hasProcessedBox = await ensureProcessedMailbox(client);
    const lock = await client.getMailboxLock("INBOX");
    try {
      // IMAP SINCE is day-granular; the Message-ID ledger + enable-time check
      // below make the final call.
      const uids = await client.search(
        { seen: false, since },
        { uid: true },
      );
      if (!uids || uids.length === 0) return;

      for (const uid of uids) {
        try {
          const msg = await client.fetchOne(
            String(uid),
            { source: true, internalDate: true },
            { uid: true },
          );
          if (!msg || !msg.source) continue;
          if (msg.internalDate && msg.internalDate < since) {
            // Pre-launch mail — leave untouched (no backfill).
            continue;
          }

          const parsed = await simpleParser(msg.source);
          const fromAddr =
            parsed.from?.value?.[0]?.address?.trim().toLowerCase() ?? "";
          const fromName = parsed.from?.value?.[0]?.name?.trim() ?? "";
          const messageId =
            parsed.messageId?.trim() || `gmail-uid-${uid}-${cfg.user}`;
          const subject = parsed.subject?.trim() ?? "";
          const body = (parsed.text ?? "").trim();

          if (await alreadyProcessed(messageId)) {
            await markHandled(client, uid, hasProcessedBox);
            continue;
          }

          // Never loop the system's own outbound mail back into leads.
          // System mail is identified by the X-AURA-System header stamped in
          // email.ts — NOT by sender address, so genuine self-sent human mail
          // (e.g. notes-to-self from the monitored inbox) is still processed.
          // Bounce/daemon senders are also skipped.
          const isSystemMail = parsed.headers.has(
            SYSTEM_MAIL_HEADER.toLowerCase(),
          );
          const isBounceSender =
            /^(mailer-daemon|postmaster|no-?reply)@/i.test(fromAddr);
          if (!fromAddr || isSystemMail || isBounceSender) {
            await recordProcessed(messageId, null);
            await markHandled(client, uid, hasProcessedBox);
            continue;
          }

          let leadId: number | null = null;
          const startedAt = Date.now();
          const extraction = await classifyEmail({
            fromName,
            fromEmail: fromAddr,
            subject,
            body,
          });
          // Confidence hard gate (R9.2): an enquiry classified below the
          // floor is NEVER auto-converted into a lead — it is routed to the
          // governance HITL queue and staff are told to triage it by hand.
          const gateReason = extraction.isEnquiry
            ? confidenceGateReason(extraction.confidence, {
                requireConfidence: true,
              })
            : null;
          if (extraction.isEnquiry && gateReason) {
            const dealerId = await defaultDealerId();
            logger.warn(
              { uid, from: fromAddr, confidence: extraction.confidence },
              "Gmail intake: enquiry below confidence floor — held for review",
            );
            await recordAgentRun({
              dealerId,
              agentKey: "sales",
              runType: "email_intake",
              inputSource: "gmail",
              inputSummary: subject || "(no subject)",
              outputSummary: `Possible enquiry from ${fromAddr} held for review: ${extraction.summary ?? "(no summary)"}`,
              confidence: extraction.confidence,
              status: "needs_review",
              reviewReason: gateReason,
              latencyMs: Date.now() - startedAt,
            });
            const coordinators = await dealerStaffIdsByRole(dealerId, [
              "Marketing Coordinator",
              "Sales Manager",
              "General Manager",
            ]);
            await notifyUsers(coordinators, {
              dealerId,
              type: "task",
              title: "Email enquiry needs manual review",
              body: `AURA was not confident enough to auto-create a lead from "${(subject || "(no subject)").slice(0, 80)}" — please review the inbox and capture it manually if genuine.`,
              link: "/agents",
            });
          } else if (extraction.isEnquiry) {
            leadId = await handleEnquiry({
              fromName,
              fromEmail: fromAddr,
              subject,
              body,
              extraction,
            });
            logger.info(
              { uid, leadId, from: fromAddr },
              "Gmail intake: enquiry email converted to lead",
            );
          } else {
            logger.info(
              { uid, from: fromAddr, subject },
              "Gmail intake: email classified as non-enquiry, skipped",
            );
          }
          if (!(extraction.isEnquiry && gateReason)) {
            await recordAgentRun({
              dealerId: await defaultDealerId(),
              agentKey: "sales",
              runType: "email_intake",
              inputSource: "gmail",
              inputSummary: subject || "(no subject)",
              outputSummary: extraction.isEnquiry
                ? `Enquiry → lead #${leadId}: ${extraction.summary ?? ""}`
                : "Classified as non-enquiry, skipped",
              confidence: extraction.confidence,
              refType: leadId != null ? "lead" : null,
              refId: leadId,
              latencyMs: Date.now() - startedAt,
              mutation: leadId != null,
              changeSummary:
                leadId != null
                  ? `No lead on file for sender → lead #${leadId} created from email enquiry`
                  : null,
            });
          }

          await recordProcessed(messageId, leadId);
          await markHandled(client, uid, hasProcessedBox);
        } catch (err) {
          // Leave the message unseen/unrecorded so the next poll retries it
          // (e.g. transient AI failure).
          logger.error({ err, uid }, "Gmail intake: failed to process message");
        }
      }
    } finally {
      lock.release();
    }
  } catch (err) {
    logger.error({ err }, "Gmail intake: IMAP poll failed");
  } finally {
    polling = false;
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }
}

let gmailTimer: ReturnType<typeof setInterval> | null = null;

export function startGmailIntakeWorker(): void {
  if (gmailTimer) return;
  gmailTimer = setInterval(() => {
    void pollGmailInbox();
  }, POLL_MS);
  // First check shortly after boot so new mail shows up fast.
  setTimeout(() => {
    void pollGmailInbox();
  }, 5_000);
  logger.info("Gmail email-to-lead intake worker started");
}
