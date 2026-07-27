import { and, eq, gt, isNotNull, isNull, notInArray } from "drizzle-orm";
import {
  db,
  leadsTable,
  timelineEventsTable,
  vehiclesTable,
  whatsappConversationsTable,
  type WhatsappConversation,
} from "@workspace/db";
import { ensureAccountForLead } from "./accounts";
import { notifyUser } from "./email";
import {
  createInboundLead,
  matchVehicleByText,
  type MatchedVehicle,
} from "./lead-intake";
import { defaultDealerId } from "./tenancy";
import type { WhatsappListRow, WhatsappTransport } from "./whatsapp";
import {
  linkWhatsappMessagesToLead,
  recordWhatsappMessage,
  recordingTransport,
} from "./whatsapp-log";
import { logger } from "./logger";
import { isAgentEnabled, recordAgentRun } from "./agent-governance";
import { rescheduleLink } from "./test-drive-scheduler";
import type { Lead } from "@workspace/db";

// ---------------------------------------------------------------------------
// WhatsApp guided lead-capture bot — deterministic state machine, shared by
// both channels (Meta Cloud API and Twilio) via a transport abstraction.
// greet → name → mobile ("use this number") → email ("skip" allowed) →
// vehicle (inventory pick with free-text fallback) → lead created via
// shared intake.
//
// Interactive transports (Meta) get native reply buttons and list messages;
// text-only transports (Twilio/TwiML) get numbered menus — the presented
// option ids are persisted on the conversation row so a numeric reply can be
// mapped back to the option it referred to.
// ---------------------------------------------------------------------------

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // half-finished chats expire after 24h
const USE_THIS_NUMBER_ID = "use_this_number";
const SKIP_EMAIL_ID = "skip_email";
const OTHER_VEHICLE_ID = "veh_other";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const OPEN_EXCLUDED_PHASES = ["won", "lost"];

const digits = (s: string): string => s.replace(/\D/g, "");

export type InboundWhatsappMessage = {
  /** Sender WhatsApp id (E.164 digits, no "+"). */
  from: string;
  profileName: string;
  /** Free text body, if a text message. */
  text: string | null;
  /** Tapped button / list-row id, if an interactive reply. */
  replyId: string | null;
  /** Tapped button / list-row title, if an interactive reply. */
  replyTitle: string | null;
};

async function findOpenLeadByPhone(dealerId: number, phone: string) {
  const needle = digits(phone);
  if (!needle) return null;
  const candidates = await db
    .select()
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.dealerId, dealerId),
        isNotNull(leadsTable.phone),
        notInArray(leadsTable.phase, OPEN_EXCLUDED_PHASES),
        isNull(leadsTable.deletedAt),
      ),
    );
  return (
    candidates.find((l) => {
      const d = digits(l.phone ?? "");
      if (!d) return false;
      return d.slice(-10) === needle.slice(-10) || d === needle;
    }) ?? null
  );
}

async function activeConversation(
  phone: string,
): Promise<WhatsappConversation | null> {
  const [row] = await db
    .select()
    .from(whatsappConversationsTable)
    .where(
      and(
        eq(whatsappConversationsTable.phone, phone),
        gt(whatsappConversationsTable.expiresAt, new Date()),
      ),
    );
  return row ?? null;
}

async function upsertConversation(
  phone: string,
  values: Partial<{
    step: string;
    name: string | null;
    mobile: string | null;
    email: string | null;
    profileName: string | null;
    menu: string | null;
    brand: string | null;
  }>,
): Promise<void> {
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db
    .insert(whatsappConversationsTable)
    .values({ phone, step: "name", ...values, expiresAt })
    .onConflictDoUpdate({
      target: whatsappConversationsTable.phone,
      set: { ...values, expiresAt, updatedAt: new Date() },
    });
}

async function endConversation(phone: string): Promise<void> {
  // Opt-out records live on this row (R6.4) — expire the session instead of
  // deleting when the phone has opted out, so the STOP preference survives.
  const [row] = await db
    .select({ optedOutAt: whatsappConversationsTable.optedOutAt })
    .from(whatsappConversationsTable)
    .where(eq(whatsappConversationsTable.phone, phone));
  if (row?.optedOutAt) {
    await db
      .update(whatsappConversationsTable)
      .set({ expiresAt: new Date(), updatedAt: new Date() })
      .where(eq(whatsappConversationsTable.phone, phone));
    return;
  }
  await db
    .delete(whatsappConversationsTable)
    .where(eq(whatsappConversationsTable.phone, phone));
}

// ---------------------------------------------------------------------------
// R6.4 WhatsApp opt-out — STOP suppresses all outbound WhatsApp for the
// phone (outbox downgrades to Email → In-App); START re-enables it.
// ---------------------------------------------------------------------------

const OPT_OUT_KEYWORDS = new Set(["stop", "unsubscribe", "opt out", "optout"]);
const OPT_IN_KEYWORDS = new Set(["start", "unstop", "resume"]);

/**
 * Intercepts STOP/START keywords BEFORE any bot logic (they must work even
 * when the concierge agent is paused). Returns the confirmation reply if the
 * message was an opt keyword, null otherwise.
 */
export async function handleOptKeyword(
  phone: string,
  text: string | null,
): Promise<string | null> {
  const keyword = (text ?? "").trim().toLowerCase();
  const isOut = OPT_OUT_KEYWORDS.has(keyword);
  const isIn = OPT_IN_KEYWORDS.has(keyword);
  if (!isOut && !isIn) return null;
  const now = new Date();
  await db
    .insert(whatsappConversationsTable)
    .values({
      phone,
      step: "done",
      optedOutAt: isOut ? now : null,
      expiresAt: now, // no active bot session — just the preference record
    })
    .onConflictDoUpdate({
      target: whatsappConversationsTable.phone,
      set: { optedOutAt: isOut ? now : null, updatedAt: now },
    });
  logger.info({ phone, optOut: isOut }, "whatsapp opt keyword processed");
  return isOut
    ? "You've been unsubscribed from WhatsApp updates. We won't message you here again — important updates will reach you by email instead. Reply START to re-subscribe."
    : "Welcome back — WhatsApp updates are switched on again.";
}

/** Map a bare numeric reply ("2") to the option id it referred to, using the
 * menu persisted when the options were presented (text-only transports). */
function resolveMenuReply(
  convo: WhatsappConversation,
  msg: InboundWhatsappMessage,
): string | null {
  if (msg.replyId) return msg.replyId;
  // Tolerate punctuation/decoration around the number ("6.", "(6)", " 6 ").
  const t = (msg.text ?? "").trim().replace(/^[^\d]*(\d{1,2})[^\d]*$/, "$1");
  if (!/^\d{1,2}$/.test(t) || !convo.menu) return null;
  try {
    const ids = JSON.parse(convo.menu) as string[];
    return ids[Number(t) - 1] ?? null;
  } catch {
    return null;
  }
}

async function availableVehicles(dealerId: number) {
  return db
    .select()
    .from(vehiclesTable)
    .where(
      and(
        eq(vehiclesTable.dealerId, dealerId),
        eq(vehiclesTable.status, "available"),
        isNull(vehiclesTable.deletedAt),
      ),
    );
}

/** Distinct makes with available stock — first menu level. */
async function buildBrandRows(dealerId: number): Promise<WhatsappListRow[]> {
  const vehicles = await availableVehicles(dealerId);
  const byMake = new Map<string, number>();
  for (const v of vehicles) {
    if (!v.make) continue;
    byMake.set(v.make, (byMake.get(v.make) ?? 0) + 1);
  }
  // WhatsApp lists cap at 10 rows: up to 9 brands + an "Other" fallback.
  return [...byMake.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 9)
    .map(([make, count]) => ({
      id: `brand_${make}`,
      title: make,
      description: `${count} in stock`,
    }));
}

/** Models of a chosen make — second menu level. */
async function buildModelRows(
  dealerId: number,
  make: string,
): Promise<WhatsappListRow[]> {
  const vehicles = (await availableVehicles(dealerId)).filter(
    (v) => (v.make ?? "").toLowerCase() === make.toLowerCase(),
  );
  // Collapse duplicates of the same model/trim so the list covers more range.
  const seen = new Set<string>();
  const rows: WhatsappListRow[] = [];
  for (const v of vehicles) {
    const key = `${v.model} ${v.trim ?? v.variant ?? ""}`.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      id: `veh_${v.id}`,
      title: `${v.make} ${v.model}`,
      description: [v.year, v.trim || v.variant, v.exteriorColor]
        .filter(Boolean)
        .join(" · "),
    });
    if (rows.length === 9) break;
  }
  return rows;
}

async function promptMobile(
  t: WhatsappTransport,
  phone: string,
  firstName: string,
  retry: boolean,
): Promise<void> {
  await upsertConversation(phone, {
    menu: JSON.stringify([USE_THIS_NUMBER_ID]),
  });
  if (t.interactive) {
    await t.sendButtons(
      phone,
      retry
        ? "That doesn't look like a valid mobile number. Type it with the area code, or tap the button to use this WhatsApp number."
        : `Nice to meet you, ${firstName}! What's the best mobile number to reach you on?\n\nTap the button to use this WhatsApp number, or type a different one.`,
      [{ id: USE_THIS_NUMBER_ID, title: "Use this number" }],
    );
    return;
  }
  await t.sendText(
    phone,
    retry
      ? "That doesn't look like a valid mobile number. Reply 1 to use this WhatsApp number, or type it with the area code."
      : `Nice to meet you, ${firstName}! What's the best mobile number to reach you on?\n\nReply 1 to use this WhatsApp number, or type a different one.`,
  );
}

async function promptEmail(
  t: WhatsappTransport,
  phone: string,
  firstName: string,
  retry: boolean,
): Promise<void> {
  await upsertConversation(phone, {
    menu: JSON.stringify([SKIP_EMAIL_ID]),
  });
  if (t.interactive) {
    await t.sendButtons(
      phone,
      retry
        ? "That doesn't look like a valid email address. Type it again, or tap Skip."
        : `Great, ${firstName}! What's your email address? We'll send your quotation there.\n\nType it below, or tap Skip.`,
      [{ id: SKIP_EMAIL_ID, title: "Skip" }],
    );
    return;
  }
  await t.sendText(
    phone,
    retry
      ? "That doesn't look like a valid email address. Type it again, or reply 1 to skip."
      : `Great, ${firstName}! What's your email address? We'll send your quotation there.\n\nType it below, or reply 1 to skip.`,
  );
}

async function promptBrand(
  t: WhatsappTransport,
  dealerId: number,
  phone: string,
  firstName: string,
): Promise<void> {
  const rows = await buildBrandRows(dealerId);
  if (rows.length === 0) {
    // No inventory to list — fall back to free text.
    await upsertConversation(phone, { step: "model", brand: null, menu: null });
    await t.sendText(
      phone,
      `Thanks ${firstName}! Which model are you interested in? Just type the make and model.`,
    );
    return;
  }
  rows.push({
    id: OTHER_VEHICLE_ID,
    title: "Other / not listed",
    description: "Tell us what you're looking for",
  });
  await upsertConversation(phone, {
    step: "brand",
    brand: null,
    menu: JSON.stringify(rows.map((r) => r.id)),
  });
  if (t.interactive) {
    await t.sendList(phone, {
      body: `Thanks ${firstName}! Which brand are you interested in? Tap below to browse our current showroom.`,
      buttonLabel: "View brands",
      sectionTitle: "Brands in stock",
      rows,
    });
    return;
  }
  const lines = rows.map(
    (r, i) =>
      `${i + 1}. ${r.title}${r.id !== OTHER_VEHICLE_ID && r.description ? ` — ${r.description}` : ""}`,
  );
  await t.sendText(
    phone,
    `Thanks ${firstName}! Which brand are you interested in? Reply with a number:\n\n${lines.join(
      "\n",
    )}\n\nOr just type the make and model you're looking for.`,
  );
}

async function promptModel(
  t: WhatsappTransport,
  dealerId: number,
  phone: string,
  firstName: string,
  make: string,
): Promise<void> {
  const rows = await buildModelRows(dealerId, make);
  if (rows.length === 0) {
    await upsertConversation(phone, { step: "model", brand: make, menu: null });
    await t.sendText(
      phone,
      `We don't have ${make} models in stock right now — just type the model you're looking for and we'll note it.`,
    );
    return;
  }
  rows.push({
    id: OTHER_VEHICLE_ID,
    title: "Other / not listed",
    description: "Tell us what you're looking for",
  });
  await upsertConversation(phone, {
    step: "model",
    brand: make,
    menu: JSON.stringify(rows.map((r) => r.id)),
  });
  if (t.interactive) {
    await t.sendList(phone, {
      body: `Great choice! Which ${make} model would you like? These are in our showroom right now.`,
      buttonLabel: "View models",
      sectionTitle: `${make} in stock`,
      rows,
    });
    return;
  }
  const lines = rows.map(
    (r, i) =>
      `${i + 1}. ${r.title}${r.id !== OTHER_VEHICLE_ID && r.description ? ` — ${r.description}` : ""}`,
  );
  await t.sendText(
    phone,
    `Great choice! Which ${make} model would you like? Reply with a number:\n\n${lines.join(
      "\n",
    )}\n\nOr just type the model name.`,
  );
}

async function completeFlow(
  t: WhatsappTransport,
  dealerId: number,
  convo: WhatsappConversation,
  vehicle: MatchedVehicle | null,
  freeTextAnswer: string | null,
): Promise<void> {
  const name = convo.name || convo.profileName || `WhatsApp ${convo.phone}`;
  const mobile = convo.mobile || `+${digits(convo.phone)}`;
  const noteParts: string[] = [];
  if (freeTextAnswer && !vehicle)
    noteParts.push(`Interested in: ${freeTextAnswer}`);
  noteParts.push("Captured by the AURA WhatsApp concierge bot.");

  const lead = await createInboundLead({
    dealerId,
    name,
    phone: mobile,
    email: convo.email || null,
    channel: "social",
    source: "whatsapp",
    notes: noteParts.join("\n"),
    vehicle,
    channelLabel: "WhatsApp",
    actor: "AURA WhatsApp Bot",
  });
  // WhatsApp leads become accounts right away (matched by email/phone,
  // created if none exists). Never throws.
  lead.customerId = await ensureAccountForLead(lead, "whatsapp");
  await recordAgentRun({
    dealerId,
    agentKey: "intake_dedup",
    runType: "whatsapp_lead_capture",
    inputSource: "whatsapp",
    inputSummary: freeTextAnswer ?? vehicle?.label ?? null,
    outputSummary: `Created lead #${lead.id} from guided WhatsApp flow`,
    confidence: 1,
    refType: "lead",
    refId: lead.id,
    mutation: true,
    changeSummary: `Guided WhatsApp flow completed → lead #${lead.id} created (deterministic state machine, no model output applied)`,
  });
  await endConversation(convo.phone);

  const firstName = name.split(/\s+/)[0];
  await t.sendText(
    convo.phone,
    vehicle
      ? `Thanks ${firstName}! We've noted your interest in the ${vehicle.label}. One of our advisors will contact you shortly on ${mobile}.`
      : `Thanks ${firstName}! We've logged your enquiry and one of our advisors will contact you shortly on ${mobile}.`,
  );
  // Link after the confirmation send so it lands in the transcript too.
  await linkWhatsappMessagesToLead(convo.phone, lead);
}

// ---------------------------------------------------------------------------
// A10 — test-drive reminder Yes/No replies. When a lead with an upcoming
// test drive answers the 24h reminder, consume the message here instead of
// treating it as a generic note.
// ---------------------------------------------------------------------------

const YES_RE = /^\s*(yes|yeah|yep|y|confirm(ed)?|ok(ay)?|sure)\s*[.!]*\s*$/i;
const NO_RE = /^\s*(no|nope|n|can'?t|cannot|cancel|reschedule)\s*[.!]*\s*$/i;

async function handleTestDriveReminderReply(
  t: WhatsappTransport,
  lead: Lead,
  msg: InboundWhatsappMessage,
): Promise<boolean> {
  const text = (msg.text ?? msg.replyTitle ?? "").trim();
  if (!text) return false;
  const upcoming =
    lead.testDriveAt && lead.testDriveAt.getTime() > Date.now();
  if (!upcoming) return false;
  const isYes = YES_RE.test(text);
  const isNo = NO_RE.test(text);
  if (!isYes && !isNo) return false;

  const whenLabel = lead.testDriveAt!.toLocaleString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  if (isYes) {
    await db.insert(timelineEventsTable).values({
      dealerId: lead.dealerId,
      customerId: lead.customerId,
      domain: "leads",
      kind: "test_drive_confirmed",
      title: `${lead.name} confirmed their test drive`,
      detail: `Replied YES to the WhatsApp reminder for ${whenLabel}.`,
      actor: "WhatsApp",
      isAgent: true,
      refType: "lead",
      refId: lead.id,
    });
    if (lead.ownerUserId) {
      await notifyUser({
        userId: lead.ownerUserId,
        dealerId: lead.dealerId,
        type: "system",
        title: `Test drive confirmed: ${lead.name}`,
        body: `Customer replied YES for ${whenLabel}. Have the car ready.`,
        link: `/lead/${lead.id}`,
      });
    }
    await t.sendText(
      msg.from,
      `Perfect — you're confirmed for ${whenLabel}. The car will be detailed and waiting. See you then!`,
    );
  } else {
    const link = rescheduleLink(lead);
    await db.insert(timelineEventsTable).values({
      dealerId: lead.dealerId,
      customerId: lead.customerId,
      domain: "leads",
      kind: "test_drive_reschedule_requested",
      title: `${lead.name} asked to reschedule their test drive`,
      detail: `Replied NO to the WhatsApp reminder for ${whenLabel}. Reschedule link sent.`,
      actor: "WhatsApp",
      isAgent: true,
      refType: "lead",
      refId: lead.id,
    });
    if (lead.ownerUserId) {
      await notifyUser({
        userId: lead.ownerUserId,
        dealerId: lead.dealerId,
        type: "system",
        title: `Reschedule requested: ${lead.name}`,
        body: `Customer replied NO to the test-drive reminder for ${whenLabel}.`,
        link: `/lead/${lead.id}`,
      });
    }
    await t.sendText(
      msg.from,
      link
        ? `No problem — you can pick a new time here (takes under a minute): ${link}`
        : `No problem — your advisor will reach out shortly to find a new time.`,
    );
  }
  await linkWhatsappMessagesToLead(msg.from, lead);
  return true;
}

/** Open-lead repeat message: append to the file instead of restarting. */
async function appendToOpenLead(
  t: WhatsappTransport,
  lead: {
    id: number;
    dealerId: number;
    name: string;
    customerId: number | null;
    ownerUserId: number | null;
  },
  msg: InboundWhatsappMessage,
): Promise<void> {
  await db.insert(timelineEventsTable).values({
    dealerId: lead.dealerId,
    customerId: lead.customerId,
    domain: "leads",
    kind: "whatsapp_message",
    title: `WhatsApp message from ${lead.name}`,
    detail: msg.text || msg.replyTitle || "(no text)",
    actor: "WhatsApp",
    isAgent: true,
    refType: "lead",
    refId: lead.id,
  });
  if (lead.ownerUserId) {
    await notifyUser({
      userId: lead.ownerUserId,
      dealerId: lead.dealerId,
      type: "system",
      title: `WhatsApp: ${lead.name}`,
      body: msg.text ? msg.text.slice(0, 180) : "New WhatsApp message received.",
      link: `/lead/${lead.id}`,
    });
  }
  await t.sendText(
    msg.from,
    "Thanks — we've noted your message and added it to your file. Your advisor will follow up shortly.",
  );
  // Link after the ack send so both the inbound message and the ack land
  // in the transcript.
  await linkWhatsappMessagesToLead(msg.from, lead);
}

/**
 * Guided-bot entry point for one inbound customer message. Assumes
 * message-id dedupe has already happened. Never throws — failures are
 * logged and the webhook still 200s.
 */
export async function handleWhatsappMessage(
  rawTransport: WhatsappTransport,
  msg: InboundWhatsappMessage,
): Promise<void> {
  const phone = msg.from;
  const t = recordingTransport(rawTransport);
  try {
    const dealerId = await defaultDealerId();
    // R6.4: STOP/START must always work — even when the bot is paused.
    const optReply = await handleOptKeyword(phone, msg.text);
    if (optReply) {
      await recordWhatsappMessage({
        phone,
        direction: "in",
        body: msg.text ?? "",
        dealerId,
      });
      await t.sendText(phone, optReply);
      return;
    }
    // Kill switch: when the concierge agent is paused for this dealer, log
    // the inbound message but do not run the bot.
    if (!(await isAgentEnabled(dealerId, "intake_dedup"))) {
      await recordWhatsappMessage({
        phone,
        direction: "in",
        body: msg.text || msg.replyTitle || "",
        dealerId,
      });
      await recordAgentRun({
        dealerId,
        agentKey: "intake_dedup",
        runType: "whatsapp_bot_reply",
        inputSource: "whatsapp",
        inputSummary: msg.text ?? msg.replyTitle ?? null,
        status: "blocked",
        errorMessage: "Agent paused by dealer kill switch",
      });
      return;
    }
    await recordWhatsappMessage({
      phone,
      direction: "in",
      body: msg.text || msg.replyTitle || "",
      dealerId,
    });
    const convo = await activeConversation(phone);

    if (!convo) {
      // Repeat message from someone with an open lead: append to their file
      // instead of restarting the guided flow.
      const existing = await findOpenLeadByPhone(dealerId, phone);
      if (existing) {
        if (await handleTestDriveReminderReply(t, existing, msg)) return;
        await appendToOpenLead(t, existing, msg);
        return;
      }

      // Fresh conversation: greet and ask for the name.
      await upsertConversation(phone, {
        step: "name",
        name: null,
        mobile: null,
        menu: null,
        profileName: msg.profileName || null,
      });
      await t.sendText(
        phone,
        "Welcome to AURA Motors! I can connect you with one of our advisors in under a minute.\n\nFirst — what's your name?",
      );
      return;
    }

    if (convo.step === "name") {
      const name = (msg.text ?? "").trim();
      if (!name || name.length < 2 || name.length > 80 || /^\d+$/.test(name)) {
        await t.sendText(
          phone,
          "Sorry, I didn't catch that — could you type your name?",
        );
        return;
      }
      await upsertConversation(phone, { step: "mobile", name });
      await promptMobile(t, phone, name.split(/\s+/)[0]!, false);
      return;
    }

    if (convo.step === "mobile") {
      const replyId = resolveMenuReply(convo, msg);
      let mobile: string | null = null;
      if (replyId === USE_THIS_NUMBER_ID) {
        mobile = `+${digits(phone)}`;
      } else if (msg.text) {
        const d = digits(msg.text);
        if (d.length >= 7 && d.length <= 15) mobile = `+${d}`;
      }
      if (!mobile) {
        await promptMobile(t, phone, (convo.name || "there").split(/\s+/)[0]!, true);
        return;
      }
      await upsertConversation(phone, { step: "email", mobile });
      await promptEmail(
        t,
        phone,
        (convo.name || "there").split(/\s+/)[0]!,
        false,
      );
      return;
    }

    if (convo.step === "email") {
      const replyId = resolveMenuReply(convo, msg);
      const firstName = (convo.name || "there").split(/\s+/)[0]!;
      const raw = (msg.text ?? "").trim();
      let email: string | null = null;
      let skipped = false;
      if (replyId === SKIP_EMAIL_ID || /^(skip|no|none)$/i.test(raw)) {
        skipped = true;
      } else if (EMAIL_RE.test(raw)) {
        email = raw.toLowerCase();
      }
      if (!email && !skipped) {
        await promptEmail(t, phone, firstName, true);
        return;
      }
      await upsertConversation(phone, { email });
      await promptBrand(t, dealerId, phone, firstName);
      return;
    }

    const firstName = (convo.name || "there").split(/\s+/)[0]!;

    if (convo.step === "brand") {
      const replyId = resolveMenuReply(convo, msg);
      if (replyId === OTHER_VEHICLE_ID) {
        await upsertConversation(phone, { step: "model", brand: null, menu: null });
        await t.sendText(
          phone,
          "No problem — just type the make and model you're looking for.",
        );
        return;
      }
      if (replyId && replyId.startsWith("brand_")) {
        await promptModel(
          t,
          dealerId,
          phone,
          firstName,
          replyId.slice("brand_".length),
        );
        return;
      }
      const answer = (msg.text ?? msg.replyTitle ?? "").trim();
      if (answer) {
        // A bare brand name shows that brand's models — checked BEFORE the
        // fuzzy vehicle match so "BYD" doesn't silently pick the first BYD.
        const brands = await buildBrandRows(dealerId);
        const hit = brands.find(
          (b) => b.title.toLowerCase() === answer.toLowerCase(),
        );
        if (hit) {
          await promptModel(t, dealerId, phone, firstName, hit.title);
          return;
        }
        // Otherwise treat it as a make+model typed outright.
        const matched = await matchVehicleByText(answer, dealerId);
        await completeFlow(t, dealerId, convo, matched, answer);
        return;
      }
      await t.sendText(
        phone,
        "Which brand are you interested in? Pick one from the list above, or type the make and model.",
      );
      return;
    }

    // step === "model"
    const replyId = resolveMenuReply(convo, msg);
    if (replyId === OTHER_VEHICLE_ID) {
      await upsertConversation(phone, { menu: null });
      await t.sendText(
        phone,
        "No problem — just type the make and model you're looking for.",
      );
      return;
    }
    if (replyId && replyId.startsWith("veh_")) {
      const vehicleId = Number(replyId.slice("veh_".length));
      const [v] = await db
        .select()
        .from(vehiclesTable)
        .where(
          and(
            eq(vehiclesTable.id, vehicleId),
            eq(vehiclesTable.dealerId, dealerId),
            eq(vehiclesTable.status, "available"),
            isNull(vehiclesTable.deletedAt),
          ),
        );
      if (v) {
        await completeFlow(
          t,
          dealerId,
          convo,
          {
            id: v.id,
            label: `${v.year} ${v.make} ${v.model}`,
            variant: v.trim || v.variant || null,
            color: v.exteriorColor || null,
          },
          null,
        );
        return;
      }
    }

    const answer = (msg.text ?? msg.replyTitle ?? "").trim();
    if (!answer) {
      await t.sendText(
        phone,
        "Which model are you interested in? Pick one from the list above, or type the make and model.",
      );
      return;
    }
    // Prefix the chosen brand (if any) so "Seal" matches "BYD Seal".
    const matched =
      (await matchVehicleByText(
        convo.brand ? `${convo.brand} ${answer}` : answer,
        dealerId,
      )) ?? (await matchVehicleByText(answer, dealerId));
    await completeFlow(t, dealerId, convo, matched, answer);
  } catch (err) {
    logger.error({ err, phone }, "WhatsApp bot failed to handle message");
  }
}

/**
 * Legacy one-shot intake for the channel NOT selected as the guided-bot
 * provider: open lead → timeline note + owner notification; otherwise a lead
 * is created straight from the first message (free text matched against
 * inventory). Mirrors the original Twilio webhook behavior. Never throws.
 */
export async function handleWhatsappOneShot(
  rawTransport: WhatsappTransport,
  msg: InboundWhatsappMessage,
): Promise<void> {
  const t = recordingTransport(rawTransport);
  try {
    const dealerId = await defaultDealerId();
    // R6.4: STOP/START must always work — even when the bot is paused.
    const optReply = await handleOptKeyword(msg.from, msg.text);
    if (optReply) {
      await recordWhatsappMessage({
        phone: msg.from,
        direction: "in",
        body: msg.text ?? "",
        dealerId,
      });
      await t.sendText(msg.from, optReply);
      return;
    }
    if (!(await isAgentEnabled(dealerId, "intake_dedup"))) {
      await recordAgentRun({
        dealerId,
        agentKey: "intake_dedup",
        runType: "whatsapp_one_shot_intake",
        inputSource: "whatsapp",
        inputSummary: msg.text ?? msg.replyTitle ?? null,
        status: "blocked",
        errorMessage: "Agent paused by dealer kill switch",
      });
      return;
    }
    await recordWhatsappMessage({
      phone: msg.from,
      direction: "in",
      body: msg.text || msg.replyTitle || "",
      dealerId,
    });
    const existing = await findOpenLeadByPhone(dealerId, msg.from);
    if (existing) {
      if (await handleTestDriveReminderReply(t, existing, msg)) return;
      await appendToOpenLead(t, existing, msg);
      return;
    }
    const body = (msg.text ?? msg.replyTitle ?? "").trim();
    const lead = await createInboundLead({
      dealerId,
      name: msg.profileName || `WhatsApp +${digits(msg.from)}`,
      phone: `+${digits(msg.from)}`,
      channel: "social",
      source: "whatsapp",
      notes: body ? `WhatsApp message: ${body}` : null,
      vehicle: await matchVehicleByText(body, dealerId),
      channelLabel: "WhatsApp",
      actor: "WhatsApp",
    });
    // WhatsApp leads become accounts right away. Never throws.
    lead.customerId = await ensureAccountForLead(lead, "whatsapp");
    await recordAgentRun({
      dealerId,
      agentKey: "intake_dedup",
      runType: "whatsapp_lead_capture",
      inputSource: "whatsapp",
      inputSummary: body || null,
      outputSummary: `Created lead #${lead.id} from one-shot WhatsApp intake`,
      confidence: 1,
      refType: "lead",
      refId: lead.id,
      mutation: true,
      changeSummary: `No open lead for sender → lead #${lead.id} + customer account created from WhatsApp message (deterministic rules, no model output applied)`,
    });
    await t.sendText(
      msg.from,
      "Thank you for contacting AURA Motors. We've received your message and one of our advisors will be in touch shortly.",
    );
    // Link after the ack send so it lands in the transcript too.
    await linkWhatsappMessagesToLead(msg.from, lead);
  } catch (err) {
    logger.error({ err, phone: msg.from }, "WhatsApp one-shot intake failed");
  }
}
