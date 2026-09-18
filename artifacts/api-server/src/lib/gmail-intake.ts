import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import {
  and,
  eq,
  gt,
  ilike,
  inArray,
  notInArray,
  isNotNull,
  isNull,
} from "drizzle-orm";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import {
  db,
  dealersTable,
  leadsTable,
  customersTable,
  jobCardsTable,
  serviceOrdersTable,
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
import {
  isServiceBookingSubject,
  normalizeServicePhone,
  parseServiceBookingForm,
  runAtomicInboundDeliveryOnce,
} from "./gmail-service-intake";
import { dealerTimezone, zonedDayKey } from "./timezone";
import { decryptSmtpPassword } from "./smtp-crypto";
import { getDealerGmailCredentialRow } from "./smtp-connection";
import { ensureInitialJobCard } from "./initial-job-card";
import {
  resolveServiceInboxes,
  serviceInboxSearch,
} from "./gmail-service-mailboxes";
export {
  isServiceBookingSubject,
  normalizeServicePhone,
  parseServiceBookingForm,
  runAtomicInboundDeliveryOnce,
} from "./gmail-service-intake";

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
// The canonical website service-booking form is routed before this sales
// classifier and creates an unconfirmed service order instead.
// Repeat senders with an open lead get a timeline note instead of a duplicate.
// Processed mail is marked \Seen and copied to the "AURA/Processed" label.
//
// Failures never crash the server: every poll is wrapped, and missing/broken
// credentials just log and leave the agent idle until the next tick.
// ---------------------------------------------------------------------------

const CHANNEL = "gmail_email";
const MARKER_CHANNEL = "gmail_intake";
const PROCESSED_MAILBOX = "AURA/Processed";
const POLL_MS = 2 * 60 * 1000;

/**
 * One watched inbox. The agent can monitor several Gmail accounts, each with
 * its own credentials, target dealer and (optionally) a subject filter that
 * restricts which mail is even considered (non-matching mail is left
 * completely untouched — unread, unlabelled — for humans working the inbox).
 */
type MailboxConfig = {
  /** Stable key used in logs and the per-mailbox polling mutex. */
  key: string;
  user: string;
  pass: string;
  /** Resolves the dealer that owns leads created from this inbox. */
  dealerId: () => Promise<number | null>;
  /** When set, only emails whose subject matches are processed. */
  subjectFilter?: RegExp;
  /**
   * Prefix for webhook_events external ids. Empty for the original mailbox
   * (keeps its historical ledger rows valid); non-empty for later mailboxes
   * so the same Message-ID delivered to two inboxes never collides.
   */
  ledgerPrefix: string;
  /** webhook_events marker id holding this mailbox's enable-time watermark. */
  markerId: string;
  /** Explicit dealer SMTP inboxes accept seen recovery mail and service only. */
  serviceOnly?: boolean;
  initialSince?: Date;
};

/** GT Automotive dealer id for the salesadmin@ inbox (name lookup, cached). */
let gtDealerIdCache: number | null = null;
const serviceConfigWarnings = new Set<string>();
async function gtSalesDealerId(): Promise<number | null> {
  const fromEnv = Number(process.env["SALESADMIN_GMAIL_DEALER_ID"]);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  if (gtDealerIdCache) return gtDealerIdCache;
  const [row] = await db
    .select({ id: dealersTable.id })
    .from(dealersTable)
    .where(eq(dealersTable.name, "GT Automotive"))
    .limit(1);
  gtDealerIdCache = row?.id ?? null;
  return gtDealerIdCache;
}

async function gmailConfigs(): Promise<MailboxConfig[]> {
  const configs: MailboxConfig[] = [];
  const user = process.env["GMAIL_USER"];
  const pass = process.env["GMAIL_APP_PASSWORD"];
  if (user && pass) {
    configs.push({
      key: "default",
      user,
      pass,
      dealerId: defaultDealerId,
      ledgerPrefix: "",
      markerId: "enabled_at",
    });
  }
  // GT Automotive sales inbox: only "Quote request" subjects become leads;
  // everything else in that inbox is left alone.
  const gtUser = process.env["SALESADMIN_GMAIL_USER"];
  const gtPass = process.env["SALESADMIN_GMAIL_APP_PASSWORD"];
  if (gtUser && gtPass) {
    configs.push({
      key: "gt-sales",
      user: gtUser,
      pass: gtPass,
      dealerId: gtSalesDealerId,
      subjectFilter: /quote\s*request/i,
      ledgerPrefix: `${gtUser}:`,
      markerId: `enabled_at:${gtUser}`,
    });
  }
  try {
    const resolved = await resolveServiceInboxes({
      raw: process.env["GMAIL_SERVICE_INBOXES"],
      legacyMailboxes: [user, gtUser],
      loadCredential: getDealerGmailCredentialRow,
      decrypt: decryptSmtpPassword,
    });
    for (const issue of resolved.issues) {
      const warningKey = `${issue.dealerId ?? "config"}:${issue.code}`;
      if (serviceConfigWarnings.has(warningKey)) continue;
      serviceConfigWarnings.add(warningKey);
      logger.warn(
        { dealerId: issue.dealerId, code: issue.code },
        "Gmail service intake: mailbox configuration rejected",
      );
    }
    configs.push(
      ...resolved.inboxes.map((inbox) => ({
        key: `service-${inbox.dealerId}-${inbox.identity}`,
        user: inbox.user,
        pass: inbox.pass,
        dealerId: async () => inbox.dealerId,
        subjectFilter: /website contact form \| book your service online/i,
        ledgerPrefix: inbox.ledgerPrefix,
        markerId: inbox.markerId,
        serviceOnly: true,
        initialSince: inbox.initialSince,
      })),
    );
  } catch {
    logger.warn(
      { code: "config_resolution_failed" },
      "Gmail service intake: could not resolve explicit mailbox configuration",
    );
  }
  return configs;
}

// ---------------------------------------------------------------------------
// Enable-time watermark — only mail arriving after the feature went live is
// processed (no historical backfill). Persisted in webhook_events so it
// survives restarts.
// ---------------------------------------------------------------------------

const enabledAtCache = new Map<string, Date>();

async function enabledAt(markerId: string, initialSince?: Date): Promise<Date> {
  const cached = enabledAtCache.get(markerId);
  if (cached) return cached;
  const [row] = await db
    .select()
    .from(webhookEventsTable)
    .where(
      and(
        eq(webhookEventsTable.channel, MARKER_CHANNEL),
        eq(webhookEventsTable.externalId, markerId),
      ),
    );
  if (row) {
    enabledAtCache.set(markerId, row.createdAt);
    return row.createdAt;
  }
  const [inserted] = await db
    .insert(webhookEventsTable)
    .values({
      channel: MARKER_CHANNEL,
      externalId: markerId,
      ...(initialSince ? { createdAt: initialSince } : {}),
    })
    .onConflictDoNothing()
    .returning();
  const [winner] = inserted
    ? [inserted]
    : await db
        .select()
        .from(webhookEventsTable)
        .where(
          and(
            eq(webhookEventsTable.channel, MARKER_CHANNEL),
            eq(webhookEventsTable.externalId, markerId),
          ),
        );
  const at = winner?.createdAt ?? initialSince ?? new Date();
  enabledAtCache.set(markerId, at);
  return at;
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
  opts?: { dealerId?: number; serviceOrderId?: number | null },
): Promise<void> {
  await db
    .insert(webhookEventsTable)
    .values({
      channel: CHANNEL,
      externalId: messageId,
      leadId,
      dealerId: opts?.dealerId ?? null,
      serviceOrderId: opts?.serviceOrderId ?? null,
    })
    .onConflictDoNothing();
}

type ServiceBookingResult = {
  orderId: number;
  requestedDate: string;
  pastRequestedDate: boolean;
  identityReview: string | null;
};

/**
 * Turn a validated website form into an unconfirmed service order.  This
 * deliberately bypasses the staff POST route: that route queues customer
 * confirmation mail, while an inbound form is only a request until staff
 * confirms it.  No VIN, registration, time, or other customer data is
 * invented here.
 */
export async function createServiceBookingFromEmail(opts: {
  dealerId: number;
  externalId: string;
  subject: string;
  text: string;
  html: string | null;
}): Promise<ServiceBookingResult | null> {
  const form = parseServiceBookingForm({ text: opts.text, html: opts.html });
  if (form.issues.length > 0) {
    const claimed = await db.transaction(async (tx) =>
      runAtomicInboundDeliveryOnce(
        async () => {
          const [row] = await tx
            .insert(webhookEventsTable)
            .values({
              channel: CHANNEL,
              externalId: opts.externalId,
              dealerId: opts.dealerId,
              leadId: null,
            })
            .onConflictDoNothing()
            .returning({ id: webhookEventsTable.id });
          return row?.id ?? null;
        },
        async () => true,
      ),
    );
    if (!claimed) return null;
    await recordAgentRun({
      dealerId: opts.dealerId,
      agentKey: "intake_dedup",
      runType: "service_booking_email_intake",
      inputSource: "gmail",
      inputSummary: opts.subject || "(no subject)",
      outputSummary: `Service booking held for review: ${form.issues.join("; ")}`,
      confidence: null,
      status: "needs_review",
      reviewReason: form.issues.join("; "),
      latencyMs: 0,
      mutation: false,
    });
    const staff = await dealerStaffIdsByRole(opts.dealerId, [
      "Service Manager",
      "Service Advisor",
      "General Manager",
    ]);
    if (staff.length > 0) {
      await notifyUsers(staff, {
        dealerId: opts.dealerId,
        type: "task",
        title: "Service booking email needs review",
        body: `The booking form "${(opts.subject || "(no subject)").slice(0, 80)}" was not created: ${form.issues.join("; ")}`,
        link: "/agents",
      });
    }
    return null;
  }

  const requestedDate = form.preferredDate!;
  const tz = await dealerTimezone(opts.dealerId);
  const pastRequestedDate = requestedDate < zonedDayKey(new Date(), tz);
  const services = form.services?.trim() || null;
  const handoff = form.waitOrDropoff?.trim() || null;
  const complaint = [
    "Pending unconfirmed service booking from website form.",
    services ? `Requested services: ${services}` : null,
    handoff ? `Vehicle handoff: ${handoff}` : null,
    pastRequestedDate
      ? `Staff review required: requested date ${requestedDate} is in the past (${tz}).`
      : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n");
  const jobs = services
    ? services
        .split(/[,;\n]+/)
        .map((service) => service.trim())
        .filter(Boolean)
    : [];

  const order = await db.transaction(async (tx) => {
    return runAtomicInboundDeliveryOnce(
      async () => {
        const [row] = await tx
          .insert(webhookEventsTable)
          .values({
            channel: CHANNEL,
            externalId: opts.externalId,
            dealerId: opts.dealerId,
            leadId: null,
          })
          .onConflictDoNothing()
          .returning({ id: webhookEventsTable.id });
        return row?.id ?? null;
      },
      async (ledgerId) => {
        const existingCustomers = await tx
          .select({
            id: customersTable.id,
            email: customersTable.email,
            phone: customersTable.phone,
          })
          .from(customersTable)
          .where(
            and(
              eq(customersTable.dealerId, opts.dealerId),
              isNull(customersTable.deletedAt),
              isNull(customersTable.erasedAt),
            ),
          );
        const emailMatches = existingCustomers.filter(
          (customer) =>
            customer.email?.trim().toLowerCase() === form.email!.toLowerCase(),
        );
        const phoneMatches = existingCustomers.filter(
          (customer) => normalizeServicePhone(customer.phone) === form.phone,
        );
        const emailId = emailMatches.length === 1 ? emailMatches[0]!.id : null;
        const phoneId = phoneMatches.length === 1 ? phoneMatches[0]!.id : null;
        const emailCustomer = emailId == null
          ? null
          : emailMatches.find((customer) => customer.id === emailId) ?? null;
        const storedEmailPhone = normalizeServicePhone(emailCustomer?.phone);
        const identityReview =
          emailCustomer && storedEmailPhone && storedEmailPhone !== form.phone
            ? `Form phone ${form.phone} differs from existing contact phone ${storedEmailPhone} for ${form.email}; staff must verify before any confirmation.`
            : emailId != null &&
                phoneId != null &&
                emailId !== phoneId
              ? `Form email and phone match different existing contacts; staff must verify identity before any confirmation.`
              : emailMatches.length > 1 || phoneMatches.length > 1
                ? `Form identity matches multiple existing contacts; staff must verify before any confirmation.`
                : null;
        // A disagreement between email and phone, or multiple matches for either,
        // is intentionally not merged. Creating a new account is safer than
        // overwriting an existing contact with an ambiguous identity.
        const customerId =
          !identityReview &&
          (emailId == null || phoneId == null || emailId === phoneId) &&
          emailMatches.length <= 1 &&
          phoneMatches.length <= 1
            ? emailId ?? phoneId
            : null;
        let linkedCustomerId = customerId;
        if (linkedCustomerId == null) {
          const [created] = await tx
            .insert(customersTable)
            .values({
              dealerId: opts.dealerId,
              name: form.name!,
              email: form.email!,
              phone: form.phone!,
            })
            .returning({ id: customersTable.id });
          linkedCustomerId = created?.id ?? null;
        }

        const effectiveComplaint = [
          complaint,
          identityReview ? `Staff review required: ${identityReview}` : null,
          `Customer form email: ${form.email}`,
        ]
          .filter((part): part is string => Boolean(part))
          .join("\n");
        const [createdOrder] = await tx
          .insert(serviceOrdersTable)
          .values({
            dealerId: opts.dealerId,
            customerId: linkedCustomerId,
            customerName: form.name!,
            customerPhoneSnapshot: form.phone!,
            vehicleInfo: form.model!,
            // VIN and registration are intentionally left null until staff
            // identifies the vehicle; the form only supplied a model.
            vin: null,
            registrationNumber: null,
            type: "repair",
            payType: "customer",
            status: "open",
            scheduledDate: requestedDate,
            complaint: effectiveComplaint,
            technician: null,
            technicianUserId: null,
            estimatedCost: 0,
            jobs,
            createdByUserId: null,
            createdByName: "AURA Gmail Service Intake",
            createdOrigin: "system",
          })
          .returning();
        if (!createdOrder) return null;
        // The form requests a date, not a confirmed appointment time.
        await ensureInitialJobCard(tx, createdOrder, { scheduledAt: null });
        await tx
          .update(webhookEventsTable)
          .set({ serviceOrderId: createdOrder.id })
          .where(eq(webhookEventsTable.id, ledgerId));
        return { order: createdOrder, identityReview };
      },
    );
  });
  if (!order) return null;
  const { order: createdOrder, identityReview } = order;
  const reviewReason = [
    pastRequestedDate ? `Requested date ${requestedDate} is in the past` : null,
    identityReview,
  ]
    .filter((reason): reason is string => Boolean(reason))
    .join("; ") || null;
  await recordAgentRun({
    dealerId: opts.dealerId,
    agentKey: "intake_dedup",
    runType: "service_booking_email_intake",
    inputSource: "gmail",
    inputSummary: opts.subject || "(no subject)",
    outputSummary: `Service request → booking #${createdOrder.id} for ${requestedDate}${
      reviewReason ? ` (staff review required: ${reviewReason})` : ""
    }. Review: /service?order=${createdOrder.id}`,
    confidence: 1,
    status: reviewReason ? "needs_review" : "completed",
    reviewReason,
    refType: "service_order",
    refId: createdOrder.id,
    latencyMs: 0,
    mutation: true,
    autonomy: "system",
    changeSummary: `Created pending unconfirmed service booking #${createdOrder.id} from Gmail form`,
  });
  const staff = await dealerStaffIdsByRole(opts.dealerId, [
    "Service Manager",
    "Service Advisor",
    "General Manager",
  ]);
  if (staff.length > 0) {
    await notifyUsers(staff, {
      dealerId: opts.dealerId,
      type: "task",
      title: `Service booking request #${createdOrder.id}`,
      body: `${form.name} <${form.email}> — ${form.model}, requested ${requestedDate}${
        reviewReason ? ` (${reviewReason})` : ""
      }`,
      link: `/service?order=${createdOrder.id}`,
    });
  }
  return {
    orderId: createdOrder.id,
    requestedDate,
    pastRequestedDate,
    identityReview,
  };
}

/**
 * Narrow historical repair: only bookings already linked from the Gmail
 * idempotency ledger and lacking every job card are eligible. Each candidate
 * is rechecked under the same dealer/order lock used by live intake.
 */
export async function repairMissingGmailServiceJobCards(
  limit = 100,
  externalIdPrefix?: string,
): Promise<number> {
  const cursorFilter =
    !externalIdPrefix && gmailRepairCursor > 0
      ? gt(serviceOrdersTable.id, gmailRepairCursor)
      : undefined;
  const candidates = await db
    .select({
      orderId: serviceOrdersTable.id,
      dealerId: serviceOrdersTable.dealerId,
      externalId: webhookEventsTable.externalId,
    })
    .from(webhookEventsTable)
    .innerJoin(
      serviceOrdersTable,
      and(
        eq(serviceOrdersTable.id, webhookEventsTable.serviceOrderId),
        eq(serviceOrdersTable.dealerId, webhookEventsTable.dealerId),
      ),
    )
    .leftJoin(
      jobCardsTable,
      and(
        eq(jobCardsTable.serviceOrderId, serviceOrdersTable.id),
        eq(jobCardsTable.dealerId, serviceOrdersTable.dealerId),
      ),
    )
    .where(
      and(
        eq(webhookEventsTable.channel, CHANNEL),
        isNotNull(webhookEventsTable.serviceOrderId),
        isNull(jobCardsTable.id),
        inArray(serviceOrdersTable.status, [
          "open",
          "acknowledged",
          "in_progress",
          "on_hold",
        ]),
        externalIdPrefix
          ? ilike(webhookEventsTable.externalId, `${externalIdPrefix}%`)
          : undefined,
        cursorFilter,
      ),
    )
    .orderBy(serviceOrdersTable.id)
    .limit(Math.max(1, Math.min(limit, 500)));
  if (!externalIdPrefix && candidates.length === 0 && gmailRepairCursor > 0) {
    gmailRepairCursor = 0;
  }
  let created = 0;
  for (const candidate of candidates) {
    if (!externalIdPrefix) gmailRepairCursor = candidate.orderId;
    try {
      if (!(await isAgentEnabled(candidate.dealerId, "intake_dedup"))) continue;
      const card = await db.transaction(async (tx) => {
        // Lifecycle changes serialize here. Never let a stale candidate snapshot
        // resurrect a terminal/deleted booking or write into a paused dealer.
        const [dealer] = await tx
          .select({
            status: dealersTable.status,
            entitlements: dealersTable.entitlements,
          })
          .from(dealersTable)
          .where(eq(dealersTable.id, candidate.dealerId))
          .for("update");
        if (
          dealer?.status !== "active" ||
          dealer.entitlements?.ai_agents === false ||
          dealer.entitlements?.gmail_intake === false
        ) {
          return null;
        }
        const [locked] = await tx
          .select({ order: serviceOrdersTable })
          .from(serviceOrdersTable)
          .innerJoin(
            webhookEventsTable,
            and(
              eq(webhookEventsTable.channel, CHANNEL),
              eq(webhookEventsTable.externalId, candidate.externalId),
              eq(webhookEventsTable.dealerId, candidate.dealerId),
              eq(webhookEventsTable.serviceOrderId, serviceOrdersTable.id),
            ),
          )
          .where(
            and(
              eq(serviceOrdersTable.id, candidate.orderId),
              eq(serviceOrdersTable.dealerId, candidate.dealerId),
              inArray(serviceOrdersTable.status, [
                "open",
                "acknowledged",
                "in_progress",
                "on_hold",
              ]),
            ),
          )
          .for("update");
        if (!locked) return null;
        return ensureInitialJobCard(tx, locked.order, { scheduledAt: null });
      });
      if (card) created += 1;
    } catch (err) {
      // Fixture-scoped calls surface failures; the recurring production sweep
      // isolates candidates so one malformed legacy row cannot starve backlog.
      if (externalIdPrefix) throw err;
      logger.error(
        {
          code: "gmail_service_job_card_candidate_failed",
          dealerId: candidate.dealerId,
          serviceOrderId: candidate.orderId,
        },
        "Gmail intake: skipped failed historical job-card candidate",
      );
    }
  }
  return created;
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
        isNull(leadsTable.deletedAt),
      ),
    );
  const needle = email.trim().toLowerCase();
  return candidates.find((l) => (l.email ?? "").trim().toLowerCase() === needle);
}

async function handleEnquiry(opts: {
  dealerId: number;
  fromName: string;
  fromEmail: string;
  subject: string;
  body: string;
  extraction: Extraction;
}): Promise<number | null> {
  const dealerId = opts.dealerId;
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
    interestedModelText: opts.extraction.vehicle,
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
    logger.warn(
      { code: "processed_mailbox_unavailable" },
      "Gmail intake: could not create processed mailbox",
    );
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
    logger.warn(
      { code: "mark_handled_failed", uid },
      "Gmail intake: failed to mark message handled",
    );
  }
}

const pollingKeys = new Set<string>();
let credWarned = false;

export async function pollGmailInbox(): Promise<void> {
  let configs: MailboxConfig[];
  try {
    configs = await gmailConfigs();
  } catch {
    logger.error(
      { code: "config_resolution_failed" },
      "Gmail service intake: could not resolve mailbox configuration",
    );
    configs = [];
  }
  if (configs.length === 0) {
    if (!credWarned) {
      logger.warn(
        "Gmail intake: no mailbox credentials set — email-to-lead agent is idle",
      );
      credWarned = true;
    }
    return;
  }
  // Sequential: one IMAP connection at a time keeps the worker gentle.
  for (const cfg of configs) {
    try {
      await pollMailbox(cfg);
    } catch {
      logger.error(
        { mailbox: cfg.key, code: "mailbox_setup_failed" },
        "Gmail intake: mailbox setup failed",
      );
    }
  }
}

async function pollMailbox(cfg: MailboxConfig): Promise<void> {
  if (pollingKeys.has(cfg.key)) return;
  let dealerId: number | null;
  try {
    dealerId = await cfg.dealerId();
  } catch {
    logger.warn(
      { mailbox: cfg.key, code: "dealer_lookup_failed" },
      "Gmail intake: could not resolve dealer for mailbox — skipping",
    );
    return;
  }
  if (!dealerId) {
    logger.warn(
      { mailbox: cfg.key },
      "Gmail intake: could not resolve dealer for mailbox — skipping",
    );
    return;
  }
  // Kill switch: dealer paused the email intake agent — skip polling entirely.
  if (!(await isAgentEnabled(dealerId, "intake_dedup"))) return;
  pollingKeys.add(cfg.key);
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });
  // ImapFlow can emit a socket error outside the awaited command promise.
  // Never let a failed mailbox connection crash the worker process or log
  // provider responses that may contain authentication details.
  client.on("error", () => {
    logger.warn(
      { mailbox: cfg.key, code: "imap_connection_error" },
      "Gmail intake: mailbox connection error",
    );
  });

  try {
    const since = await enabledAt(cfg.markerId, cfg.initialSince);
    await client.connect();
    const hasProcessedBox = await ensureProcessedMailbox(client);
    const lock = await client.getMailboxLock("INBOX");
    try {
      // IMAP SINCE is day-granular; the Message-ID ledger + enable-time check
      // below make the final call.
      const uids = await client.search(
        cfg.serviceOnly ? serviceInboxSearch(since) : { seen: false, since },
        { uid: true },
      );
      if (!uids || uids.length === 0) return;

      for (const uid of uids) {
        try {
          const metadata = await client.fetchOne(
            String(uid),
            { envelope: true, internalDate: true },
            { uid: true },
          );
          if (!metadata) continue;
          if (metadata.internalDate && metadata.internalDate < since) {
            // Pre-launch mail — leave untouched (no backfill).
            continue;
          }

          const subject = metadata.envelope?.subject?.trim() ?? "";
          const messageId =
            metadata.envelope?.messageId?.trim() || `gmail-uid-${uid}-${cfg.user}`;
          const externalId = `${cfg.ledgerPrefix}${messageId}`;
          const subjectMatches = cfg.serviceOnly
            ? isServiceBookingSubject(subject)
            : isServiceBookingSubject(subject) ||
              !cfg.subjectFilter ||
              cfg.subjectFilter.test(subject);
          if (await alreadyProcessed(externalId)) {
            // Service-only inboxes include seen mail, so this branch recurs
            // on each poll. Do not repeatedly copy an already-handled email.
            if (subjectMatches && !cfg.serviceOnly) {
              await markHandled(client, uid, hasProcessedBox);
            }
            continue;
          }
          if (!subjectMatches) {
            // Explicit dealer inboxes are service-only: unrelated mail is not
            // read, marked, classified, or written to the non-service ledger.
            if (!cfg.serviceOnly) await recordProcessed(externalId, null);
            continue;
          }
          const msg = await client.fetchOne(
            String(uid),
            { source: true },
            { uid: true },
          );
          if (!msg || !msg.source) continue;
          const parsed = await simpleParser(msg.source);
          const fromAddr =
            parsed.from?.value?.[0]?.address?.trim().toLowerCase() ?? "";
          const fromName = parsed.from?.value?.[0]?.name?.trim() ?? "";
          const body = (parsed.text ?? "").trim();
          const html =
            typeof parsed.html === "string" ? parsed.html.trim() : null;

          // Subject-filtered mailboxes (e.g. GT sales): mail that doesn't
          // match is NOT ours to touch — leave it unread and unlabelled for
          // the humans working that inbox. Ledger it so we skip it cheaply.
          // Never loop the system's own outbound mail back into leads.
          // System mail is identified by the X-AURA-System header stamped in
          // email.ts — NOT by sender address, so genuine self-sent human mail
          // (e.g. notes-to-self from the monitored inbox) is still processed.
          // Bounce/daemon senders are also skipped.
          const isSystemMail = parsed.headers.has(
            SYSTEM_MAIL_HEADER.toLowerCase(),
          );
          const isBounceSender =
            /^(mailer-daemon|postmaster)@/i.test(fromAddr);
          if (!fromAddr || isSystemMail || isBounceSender) {
             await recordProcessed(externalId, null, { dealerId });
            await markHandled(client, uid, hasProcessedBox);
            continue;
          }

           // Service form notifications are routed before the sales
           // classifier.  The SMTP sender is a relay and is never used as
           // the customer identity; only labelled form fields are accepted.
           if (isServiceBookingSubject(subject)) {
             await createServiceBookingFromEmail({
               dealerId,
               externalId,
               subject,
               text: body,
               html,
             });
             // Invalid/missing fields and duplicate deliveries are claimed in
             // the same ledger path by the service intake helper; no sales
             // lead fallback is allowed.
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
            logger.warn(
              { uid, from: fromAddr, confidence: extraction.confidence },
              "Gmail intake: enquiry below confidence floor — held for review",
            );
            await recordAgentRun({
              dealerId,
              agentKey: "intake_dedup",
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
              dealerId,
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
              dealerId,
              agentKey: "intake_dedup",
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

          await recordProcessed(externalId, leadId);
          await markHandled(client, uid, hasProcessedBox);
        } catch (err) {
          // Leave the message unseen/unrecorded so the next poll retries it
          // (e.g. transient AI failure).
          logger.error(
            cfg.serviceOnly
              ? { code: "service_message_processing_failed", uid }
              : { err, uid },
            "Gmail intake: failed to process message",
          );
        }
      }
    } finally {
      lock.release();
    }
  } catch (err) {
    logger.error(
      { mailbox: cfg.key, code: "imap_poll_failed" },
      "Gmail intake: IMAP poll failed",
    );
  } finally {
    pollingKeys.delete(cfg.key);
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }
}

let gmailTimer: ReturnType<typeof setInterval> | null = null;
let gmailRepairRunning = false;
let gmailRepairCursor = 0;

async function runGmailJobCardRepair(): Promise<void> {
  if (gmailRepairRunning) return;
  gmailRepairRunning = true;
  try {
    await repairMissingGmailServiceJobCards();
  } catch {
    logger.error(
      { code: "gmail_service_job_card_repair_failed" },
      "Gmail intake: historical job-card repair failed",
    );
  } finally {
    gmailRepairRunning = false;
  }
}

export function startGmailIntakeWorker(): void {
  if (gmailTimer) return;
  gmailTimer = setInterval(() => {
    void runGmailJobCardRepair();
    void pollGmailInbox();
  }, POLL_MS);
  // First check shortly after boot so new mail shows up fast.
  setTimeout(() => {
    void runGmailJobCardRepair();
    void pollGmailInbox();
  }, 5_000);
  logger.info("Gmail email-to-lead intake worker started");
}
