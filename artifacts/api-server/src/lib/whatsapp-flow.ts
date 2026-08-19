import { and, eq, gt, isNotNull, isNull, notInArray } from "drizzle-orm";
import {
  db,
  dealsTable,
  leadsTable,
  timelineEventsTable,
  vehiclesTable,
  whatsappConversationsTable,
  whatsappMessagesTable,
  type WhatsappConversation,
} from "@workspace/db";
import { ensureAccountForLead } from "./accounts";
import { notifyUser } from "./email";
import {
  createConfirmedRepeatInboundLead,
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
import {
  classifyRepeatCustomerIntent,
  interpretWhatsappLeadMessage,
} from "./whatsapp-ai-concierge";
import { normalizeWhatsappPhone } from "./whatsapp-phone";

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
const SKIP_ADDRESS_ID = "skip_address";
const OTHER_VEHICLE_ID = "veh_other";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const OPEN_EXCLUDED_PHASES = ["won", "lost"];

const digits = (s: string): string => normalizeWhatsappPhone(s) ?? "";

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
      return d === needle;
    }) ?? null
  );
}

async function activeConversation(
  dealerId: number,
  phone: string,
): Promise<WhatsappConversation | null> {
  const canonical = digits(phone);
  if (!canonical) return null;
  const [row] = await db
    .select()
    .from(whatsappConversationsTable)
    .where(
      and(
        eq(whatsappConversationsTable.dealerId, dealerId),
        eq(whatsappConversationsTable.phone, canonical),
        gt(whatsappConversationsTable.expiresAt, new Date()),
      ),
    );
  return row ?? null;
}

async function upsertConversation(
  dealerId: number,
  phone: string,
  values: Partial<{
    step: string;
    name: string | null;
    mobile: string | null;
    email: string | null;
    address: string | null;
    interestedVehicleId: number | null;
    profileName: string | null;
    menu: string | null;
    brand: string | null;
  }>,
): Promise<void> {
  const canonical = digits(phone);
  if (!canonical) throw new Error("Invalid WhatsApp phone");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db
    .insert(whatsappConversationsTable)
    .values({ dealerId, phone: canonical, step: "name", ...values, expiresAt })
    .onConflictDoUpdate({
      target: [whatsappConversationsTable.dealerId, whatsappConversationsTable.phone],
      set: { ...values, expiresAt, updatedAt: new Date() },
    });
}

async function endConversation(dealerId: number, phone: string): Promise<void> {
  const canonical = digits(phone);
  if (!canonical) return;
  // Opt-out records live on this row (R6.4) — expire the session instead of
  // deleting when the phone has opted out, so the STOP preference survives.
  const [row] = await db
    .select({ optedOutAt: whatsappConversationsTable.optedOutAt })
    .from(whatsappConversationsTable)
    .where(
      and(
        eq(whatsappConversationsTable.dealerId, dealerId),
        eq(whatsappConversationsTable.phone, canonical),
      ),
    );
  if (row?.optedOutAt) {
    await db
      .update(whatsappConversationsTable)
      .set({ expiresAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(whatsappConversationsTable.dealerId, dealerId),
          eq(whatsappConversationsTable.phone, canonical),
        ),
      );
    return;
  }
  await db
    .delete(whatsappConversationsTable)
    .where(
      and(
        eq(whatsappConversationsTable.dealerId, dealerId),
        eq(whatsappConversationsTable.phone, canonical),
      ),
    );
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
  dealerId: number,
  phone: string,
  text: string | null,
): Promise<string | null> {
  const keyword = (text ?? "").trim().toLowerCase();
  const isOut = OPT_OUT_KEYWORDS.has(keyword);
  const isIn = OPT_IN_KEYWORDS.has(keyword);
  if (!isOut && !isIn) return null;
  const canonical = digits(phone);
  if (!canonical) return null;
  const now = new Date();
  await db
    .insert(whatsappConversationsTable)
    .values({
      dealerId,
      phone: canonical,
      step: "done",
      optedOutAt: isOut ? now : null,
      expiresAt: now, // no active bot session — just the preference record
    })
    .onConflictDoUpdate({
      target: [whatsappConversationsTable.dealerId, whatsappConversationsTable.phone],
      set: { optedOutAt: isOut ? now : null, updatedAt: now },
    });
  logger.info(
    { dealerId, phone: canonical, optOut: isOut },
    "whatsapp opt keyword processed",
  );
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

const STEP_RANK: Record<string, number> = {
  name: 0,
  mobile: 1,
  email: 2,
  address: 3,
  brand: 4,
  model: 4,
  confirm: 5,
};

function validAiName(name: string | null): string | null {
  if (!name || name.length < 2 || name.length > 80 || /^\d+$/.test(name)) return null;
  return name;
}

function validAiEmail(email: string | null): string | null {
  return email && EMAIL_RE.test(email) ? email : null;
}

function validAiAddress(address: string | null): string | null {
  return address && address.length >= 3 && address.length <= 300 ? address : null;
}

async function handleAiLeadCapture(
  t: WhatsappTransport,
  dealerId: number,
  convo: WhatsappConversation,
  msg: InboundWhatsappMessage,
): Promise<boolean> {
  const customerMessage = (msg.text ?? "").trim();
  if (!customerMessage || customerMessage.length > 1500 || /^\d{1,2}[.)]?$/.test(customerMessage)) {
    return false;
  }

  if (convo.step === "confirm") {
    if (/^(yes|y|confirm|confirmed|correct|looks good|go ahead)\s*[.!]*$/i.test(customerMessage)) {
      const freshInventory = await availableVehicles(dealerId);
      const selectedVehicle =
        freshInventory.find((vehicle) => vehicle.id === convo.interestedVehicleId) ??
        null;
      if (!selectedVehicle) {
        await upsertConversation(dealerId, convo.phone, {
          step: "model",
          interestedVehicleId: null,
        });
        await t.sendText(
          convo.phone,
          "That vehicle is no longer marked available. Please choose another model from our current inventory.",
        );
        await promptBrand(
          t,
          dealerId,
          convo.phone,
          (convo.name || "there").split(/\s+/)[0]!,
        );
        return true;
      }
      await completeFlow(
        t,
        dealerId,
        convo,
        {
          id: selectedVehicle.id,
          label: [selectedVehicle.year, selectedVehicle.make, selectedVehicle.model]
            .filter(Boolean)
            .join(" "),
          variant: selectedVehicle.trim || selectedVehicle.variant || null,
          color: selectedVehicle.exteriorColor || null,
        },
        null,
      );
      return true;
    }
    if (/^(no|n|incorrect|change it)\s*[.!]*$/i.test(customerMessage)) {
      await t.sendText(
        convo.phone,
        "No problem. Tell me which detail you want to change—for example, your email, address, or vehicle.",
      );
      return true;
    }
  }

  // Durable per-customer budget: Meta deliveries often share provider IPs, so
  // rate AI usage by sender rather than relying on public-IP middleware.
  const recentInbound = await db
    .select({ id: whatsappMessagesTable.id })
    .from(whatsappMessagesTable)
    .where(
      and(
        eq(whatsappMessagesTable.dealerId, dealerId),
        eq(whatsappMessagesTable.phone, convo.phone),
        eq(whatsappMessagesTable.direction, "in"),
        gt(
          whatsappMessagesTable.createdAt,
          new Date(Date.now() - 60 * 1000),
        ),
      ),
    )
    .limit(6);
  if (recentInbound.length > 5) return false;

  const inventory = await availableVehicles(dealerId);
  const rank = STEP_RANK[convo.step] ?? 0;
  const explicitSkip = /^(skip|no|none|prefer not|rather not)\s*[.!]*$/i.test(
    customerMessage,
  );
  const skipEmail = convo.step === "email" && explicitSkip;
  const skipAddress = convo.step === "address" && explicitSkip;
  const interpretation =
    skipEmail || skipAddress
      ? {
          name: null,
          email: null,
          address: null,
          vehicleId: null,
          confidence: 1,
        }
      : await interpretWhatsappLeadMessage({
          dealerId,
          customerMessage,
          profileName: convo.profileName,
          facts: {
            name: convo.name,
            email: convo.email,
            address: convo.address,
            vehicleId: convo.interestedVehicleId,
            emailAlreadyPassed: rank > STEP_RANK.email,
            addressAlreadyPassed: rank > STEP_RANK.address,
          },
          inventory: inventory.map((vehicle) => ({
            id: vehicle.id,
            label: [
              vehicle.year,
              vehicle.make,
              vehicle.model,
              vehicle.trim || vehicle.variant,
            ]
              .filter(Boolean)
              .join(" "),
          })),
        });
  if (!interpretation || interpretation.confidence < 0.75) return false;

  const name = validAiName(interpretation.name) ?? convo.name;
  const email = validAiEmail(interpretation.email) ?? convo.email;
  const address = validAiAddress(interpretation.address) ?? convo.address;
  const selectedVehicle =
    inventory.find(
      (vehicle) =>
        vehicle.id === (interpretation.vehicleId ?? convo.interestedVehicleId),
    ) ?? null;
  const emailPassed =
    Boolean(email) || rank > STEP_RANK.email || skipEmail;
  const addressPassed =
    Boolean(address) || rank > STEP_RANK.address || skipAddress;
  const expectedQuestion: "name" | "email" | "address" | "vehicle" | "none" = !name
    ? "name"
    : !emailPassed
      ? "email"
      : !addressPassed
        ? "address"
        : !selectedVehicle
          ? "vehicle"
          : "none";
  const step =
    expectedQuestion === "name"
      ? "name"
      : expectedQuestion === "email"
        ? "email"
        : expectedQuestion === "address"
          ? "address"
          : expectedQuestion === "vehicle"
            ? "model"
            : "confirm";

  await upsertConversation(dealerId, convo.phone, {
    step,
    name,
    mobile: convo.mobile || `+${digits(convo.phone)}`,
    email,
    address,
    interestedVehicleId: selectedVehicle?.id ?? convo.interestedVehicleId,
    menu: null,
  });

  if (expectedQuestion === "none" && selectedVehicle) {
    await t.sendText(
      convo.phone,
      `Please confirm these enquiry details:\n\nName: ${name}\nEmail: ${
        email || "Not provided"
      }\nAddress: ${address || "Not provided"}\nVehicle: ${[
        selectedVehicle.year,
        selectedVehicle.make,
        selectedVehicle.model,
      ]
        .filter(Boolean)
        .join(" ")}\n\nReply YES to create your enquiry, or tell me what to change.`,
    );
    return true;
  }

  const firstName = (name || "there").split(/\s+/)[0]!;
  if (expectedQuestion === "name") {
    await t.sendText(
      convo.phone,
      "Welcome to AURA Motors! I'm the virtual sales concierge. What's your name?",
    );
  } else if (expectedQuestion === "email") {
    await promptEmail(t, dealerId, convo.phone, firstName, false);
  } else if (expectedQuestion === "address") {
    await promptAddress(t, dealerId, convo.phone, firstName);
  } else {
    await promptBrand(t, dealerId, convo.phone, firstName);
  }
  return true;
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
  dealerId: number,
  phone: string,
  firstName: string,
  retry: boolean,
): Promise<void> {
  await upsertConversation(dealerId, phone, {
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
  dealerId: number,
  phone: string,
  firstName: string,
  retry: boolean,
): Promise<void> {
  await upsertConversation(dealerId, phone, {
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

async function promptAddress(
  t: WhatsappTransport,
  dealerId: number,
  phone: string,
  firstName: string,
): Promise<void> {
  await upsertConversation(dealerId, phone, {
    step: "address",
    menu: JSON.stringify([SKIP_ADDRESS_ID]),
  });
  if (t.interactive) {
    await t.sendButtons(
      phone,
      `Thanks ${firstName}! What's your address? This helps us assign the nearest advisor.\n\nType it below, or tap Skip.`,
      [{ id: SKIP_ADDRESS_ID, title: "Skip" }],
    );
    return;
  }
  await t.sendText(
    phone,
    `Thanks ${firstName}! What's your address? This helps us assign the nearest advisor.\n\nType it below, or reply 1 to skip.`,
  );
}

async function promptBrand(
  t: WhatsappTransport,
  dealerId: number,
  phone: string,
  firstName: string,
  flow: "standard" | "new_enquiry" = "standard",
): Promise<void> {
  const brandStep = flow === "new_enquiry" ? "ni_brand" : "brand";
  const modelStep = flow === "new_enquiry" ? "ni_model" : "model";
  const rows = await buildBrandRows(dealerId);
  if (rows.length === 0) {
    // No inventory to list — fall back to free text.
    await upsertConversation(dealerId, phone, {
      step: modelStep,
      brand: null,
      menu: null,
    });
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
  await upsertConversation(dealerId, phone, {
    step: brandStep,
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
  flow: "standard" | "new_enquiry" = "standard",
): Promise<void> {
  const modelStep = flow === "new_enquiry" ? "ni_model" : "model";
  const rows = await buildModelRows(dealerId, make);
  if (rows.length === 0) {
    await upsertConversation(dealerId, phone, {
      step: modelStep,
      brand: make,
      menu: null,
    });
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
  await upsertConversation(dealerId, phone, {
    step: modelStep,
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
    address: convo.address || null,
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
  await endConversation(dealerId, convo.phone);

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

// ---------------------------------------------------------------------------
// R#220 — Repeat-customer inbound: intent-aware handling.
// New conversation step names used (never modify schema columns):
//   "ni_confirm"  — asking customer to confirm they want a new enquiry
//   "ni_name"     — new-enquiry intake: collect name (reuse from existing lead)
//   "ni_email"    — new-enquiry intake: collect email
//   "ni_address"  — new-enquiry intake: collect address
//   "ni_brand"    — new-enquiry intake: pick brand
//   "ni_model"    — new-enquiry intake: pick model
//   "ni_confirm_details" — new-enquiry intake: confirm all fields
// ---------------------------------------------------------------------------

type RepeatLeadRef = {
  id: number;
  dealerId: number;
  name: string;
  customerId: number | null;
  ownerUserId: number | null;
  phase: string;
  interestedVehicleId: number | null;
};

/** Log a timeline event and (optionally) notify the lead owner. */
async function logHandoffAndNotify(
  lead: RepeatLeadRef,
  kind: string,
  title: string,
  detail: string,
  notifyTitle?: string,
  notifyBody?: string,
): Promise<void> {
  await db.insert(timelineEventsTable).values({
    dealerId: lead.dealerId,
    customerId: lead.customerId,
    domain: "leads",
    kind,
    title,
    detail,
    actor: "WhatsApp",
    isAgent: true,
    refType: "lead",
    refId: lead.id,
  });
  if (lead.ownerUserId && notifyTitle) {
    await notifyUser({
      userId: lead.ownerUserId,
      dealerId: lead.dealerId,
      type: "system",
      title: notifyTitle,
      body: notifyBody ?? detail.slice(0, 180),
      link: `/lead/${lead.id}`,
    });
  }
}

/** Build a safe status reply from verified lead/deal facts only. Never invents
 *  pricing, stock, finance approval, or delivery dates. */
async function buildStatusReply(lead: RepeatLeadRef): Promise<string> {
  const firstName = lead.name.split(/\s+/)[0] ?? lead.name;

  // Fetch vehicle label if present (from THIS dealer only — enforced by dealerId join).
  let vehicleLabel: string | null = null;
  if (lead.interestedVehicleId) {
    const [v] = await db
      .select({ year: vehiclesTable.year, make: vehiclesTable.make, model: vehiclesTable.model })
      .from(vehiclesTable)
      .where(
        and(
          eq(vehiclesTable.id, lead.interestedVehicleId),
          eq(vehiclesTable.dealerId, lead.dealerId),
          isNull(vehiclesTable.deletedAt),
        ),
      );
    if (v) vehicleLabel = [v.year, v.make, v.model].filter(Boolean).join(" ");
  }

  // Fetch the most recent active deal for this lead (from THIS dealer only).
  const [deal] = await db
    .select({ stage: dealsTable.stage, salesAdvisor: dealsTable.salesAdvisor })
    .from(dealsTable)
    .where(
      and(
        eq(dealsTable.dealerId, lead.dealerId),
        eq(dealsTable.leadId, lead.id),
        notInArray(dealsTable.stage, ["cancelled", "lost"]),
      ),
    )
    .limit(1);

  const phaseLabels: Record<string, string> = {
    new: "new — our team will be in touch shortly",
    contacted: "under review with our sales team",
    qualified: "being prepared for a proposal",
    proposal: "at the proposal stage — check your email for a quotation",
    negotiation: "in the final stages — your advisor is preparing your offer",
    won: "completed — congratulations on your purchase!",
    lost: "closed",
  };
  const phaseText = phaseLabels[lead.phase] ?? lead.phase;

  const lines: string[] = [`Hi ${firstName}! Here's a summary of your current enquiry with us:`];
  if (vehicleLabel) lines.push(`🚗 Vehicle: ${vehicleLabel}`);
  lines.push(`📋 Enquiry status: ${phaseText}`);

  if (deal) {
    const dealStageLabels: Record<string, string> = {
      desking: "in progress — your deal is being prepared",
      committed: "committed — awaiting final steps",
      delivered: "complete — your vehicle has been delivered",
    };
    lines.push(`📝 Deal status: ${dealStageLabels[deal.stage] ?? deal.stage}`);
    if (deal.salesAdvisor) lines.push(`👤 Your advisor: ${deal.salesAdvisor}`);
  }

  lines.push(
    "\nFor specific questions about pricing, finance, delivery dates, or availability, your advisor is best placed to help — they'll follow up with you directly.",
  );

  return lines.join("\n");
}

/**
 * Intent-aware handler for a repeat customer's inbound WhatsApp message.
 *
 * Routes to:
 *  - status: answers with verified lead/deal facts only
 *  - help/unclear: logs handoff timeline event + notifies owner + helpful reply
 *  - new_enquiry: asks for explicit confirmation before starting a new intake
 *
 * Also drives the new-enquiry intake state machine (steps prefixed "ni_").
 */
async function handleRepeatCustomerMessage(
  t: WhatsappTransport,
  lead: RepeatLeadRef,
  msg: InboundWhatsappMessage,
  existingConvo: WhatsappConversation | null,
): Promise<void> {
  const phone = msg.from;
  const firstName = lead.name.split(/\s+/)[0] ?? lead.name;
  const text = (msg.text ?? "").trim();

  // ── New-enquiry intake state machine (ni_* steps) ──────────────────────
  // These steps live on the whatsapp_conversations row using the `step` field
  // with "ni_" prefix. No schema columns are added; we reuse existing fields.

  if (existingConvo) {
    const step = existingConvo.step;

    if (step === "ni_creating") {
      await t.sendText(
        phone,
        "Your confirmed enquiry is already being processed. Your advisor will follow up shortly.",
      );
      return;
    }

    // ── ni_confirm: waiting for explicit confirmation ────────────────────
    if (step === "ni_confirm") {
      const confirmed =
        /^(yes|y|confirm(ed)?|ok(ay)?|sure|go ahead|yep|yeah)\s*[.!]*$/i.test(text);
      const cancelled =
        /^(no|n|cancel|nope|stop|never mind|nevermind|forget it)\s*[.!]*$/i.test(text);

      if (confirmed) {
        // Idempotency: only advance if still on ni_confirm.
        await upsertConversation(lead.dealerId, phone, {
          step: "ni_name",
          name: lead.name, // pre-fill from existing lead — customer can update
          email: null,
          address: null,
          interestedVehicleId: null,
          menu: null,
        });
        await t.sendText(
          phone,
          `Great! Let's start a fresh enquiry for you.\n\nI have your name as *${lead.name}* — is that still correct? (Reply YES to keep it, or type your updated name.)`,
        );
        return;
      }

      if (cancelled) {
        await endConversation(lead.dealerId, phone);
        await t.sendText(
          phone,
          `No problem, ${firstName} — I've kept your existing enquiry open. Your advisor will be in touch. Is there anything else I can help with?`,
        );
        await linkWhatsappMessagesToLead(phone, lead);
        return;
      }

      // Ambiguous response — re-prompt.
      await t.sendText(
        phone,
        `Sorry, I didn't catch that. Reply *YES* to start a new enquiry, or *NO* to stay with your existing one.`,
      );
      return;
    }

    // ── ni_name: confirm / update name ───────────────────────────────────
    if (step === "ni_name") {
      let name = existingConvo.name ?? lead.name;
      const isYes = /^(yes|y|correct|ok(ay)?|same|keep it)\s*[.!]*$/i.test(text);
      if (!isYes && text.length >= 2 && text.length <= 80 && !/^\d+$/.test(text)) {
        name = text;
      } else if (!isYes) {
        await t.sendText(phone, "Please type your name, or reply YES to keep it as is.");
        return;
      }
      await upsertConversation(lead.dealerId, phone, {
        step: "ni_email",
        name,
        menu: JSON.stringify([SKIP_EMAIL_ID]),
      });
      if (t.interactive) {
        await t.sendButtons(
          phone,
          `Thanks ${name.split(/\s+/)[0]!}! What's your email address? (Tap Skip if you'd prefer not to provide one.)`,
          [{ id: SKIP_EMAIL_ID, title: "Skip" }],
        );
      } else {
        await t.sendText(
          phone,
          `Thanks ${name.split(/\s+/)[0]!}! What's your email address? Reply 1 to skip.`,
        );
      }
      return;
    }

    // ── ni_email: collect email ───────────────────────────────────────────
    if (step === "ni_email") {
      const replyId = resolveMenuReply(existingConvo, msg);
      const isSkipped = replyId === SKIP_EMAIL_ID || /^(skip|no|none)$/i.test(text);
      const isValid = EMAIL_RE.test(text);
      if (!isValid && !isSkipped) {
        await t.sendText(
          phone,
          "That doesn't look like a valid email address. Please try again, or reply SKIP.",
        );
        return;
      }
      const email = isValid ? text.toLowerCase() : null;
      await upsertConversation(lead.dealerId, phone, {
        step: "ni_address",
        email,
        menu: JSON.stringify([SKIP_ADDRESS_ID]),
      });
      const niFirst = (existingConvo.name ?? lead.name).split(/\s+/)[0]!;
      if (t.interactive) {
        await t.sendButtons(
          phone,
          `Thanks! What's your address? (Helps us assign the nearest advisor.)`,
          [{ id: SKIP_ADDRESS_ID, title: "Skip" }],
        );
      } else {
        await t.sendText(phone, `Thanks! What's your address? Reply 1 to skip.`);
      }
      void niFirst; // used in message above
      return;
    }

    // ── ni_address: collect address ───────────────────────────────────────
    if (step === "ni_address") {
      const replyId = resolveMenuReply(existingConvo, msg);
      const isSkipped = replyId === SKIP_ADDRESS_ID || /^(skip|no|none)$/i.test(text);
      let address: string | null = null;
      if (!isSkipped) {
        if (text.length >= 3) {
          address = text.slice(0, 300);
        } else {
          await t.sendText(phone, "Sorry, I didn't catch that. Please type your address or reply SKIP.");
          return;
        }
      }
      await upsertConversation(lead.dealerId, phone, {
        step: "ni_brand",
        address,
        menu: null,
      });
      const niFirstB = (existingConvo.name ?? lead.name).split(/\s+/)[0]!;
      await promptBrand(t, lead.dealerId, phone, niFirstB, "new_enquiry");
      return;
    }

    // ── ni_brand / ni_model: handled by brand/model logic below ──────────
    // We remap these to the standard brand/model logic by temporarily
    // treating the step as "brand" or "model" respectively.
    if (step === "ni_brand" || step === "ni_model") {
      // Swap step prefix so the existing brand/model handlers apply.
      const fakeStep = step === "ni_brand" ? "brand" : "model";
      const fakeConvo: WhatsappConversation = { ...existingConvo, step: fakeStep };
      // Delegate to a version of completeFlow that creates a NEW lead
      // instead of completing the existing one.
      await handleNiVehicleStep(t, lead, fakeConvo, msg, step);
      return;
    }

    // ── ni_confirm_details: final confirmation before creating new lead ───
    if (step === "ni_confirm_details") {
      const confirmed =
        /^(yes|y|confirm(ed)?|ok(ay)?|sure|go ahead|looks good)\s*[.!]*$/i.test(text);
      const cancelled =
        /^(no|n|cancel|nope|change)\s*[.!]*$/i.test(text);

      if (confirmed) {
        await completeNewEnquiryFlow(t, lead, existingConvo);
        return;
      }
      if (cancelled) {
        await t.sendText(
          phone,
          "No problem — tell me which detail you'd like to change (e.g. email, address, or vehicle).",
        );
        // Go back to ni_email step so they can re-provide fields.
        await upsertConversation(lead.dealerId, phone, {
          step: "ni_email",
          menu: JSON.stringify([SKIP_EMAIL_ID]),
        });
        return;
      }
      await t.sendText(
        phone,
        "Reply *YES* to confirm and submit your new enquiry, or *NO* to make changes.",
      );
      return;
    }
  }

  // ── No active ni_* convo: classify intent ────────────────────────────────
  const messageBody = (msg.text ?? msg.replyTitle ?? "").trim();

  // Look up vehicle label for context (from THIS dealer only).
  let vehicleLabel: string | null = null;
  if (lead.interestedVehicleId) {
    const [v] = await db
      .select({ year: vehiclesTable.year, make: vehiclesTable.make, model: vehiclesTable.model })
      .from(vehiclesTable)
      .where(
        and(
          eq(vehiclesTable.id, lead.interestedVehicleId),
          eq(vehiclesTable.dealerId, lead.dealerId),
          isNull(vehiclesTable.deletedAt),
        ),
      );
    if (v) vehicleLabel = [v.year, v.make, v.model].filter(Boolean).join(" ");
  }

  // Check whether there's an active deal for context only.
  const [activeDeal] = await db
    .select({ id: dealsTable.id })
    .from(dealsTable)
    .where(
      and(
        eq(dealsTable.dealerId, lead.dealerId),
        eq(dealsTable.leadId, lead.id),
        notInArray(dealsTable.stage, ["cancelled", "lost"]),
      ),
    )
    .limit(1);

  const intentResult = await classifyRepeatCustomerIntent({
    dealerId: lead.dealerId,
    customerMessage: messageBody || "(no text)",
    leadPhase: lead.phase,
    leadVehicleLabel: vehicleLabel,
    hasDeal: !!activeDeal,
  });

  logger.info(
    { leadId: lead.id, intent: intentResult.intent, confidence: intentResult.confidence },
    "whatsapp repeat-customer intent classified",
  );

  // ── INTENT: status ───────────────────────────────────────────────────────
  if (intentResult.intent === "status" && intentResult.confidence >= 0.7) {
    await logHandoffAndNotify(
      lead,
      "whatsapp_status_check",
      `${lead.name} asked for a status update`,
      `Message: "${messageBody.slice(0, 200)}"${intentResult.staffSummary ? ` — ${intentResult.staffSummary}` : ""}`,
    );
    const reply = await buildStatusReply(lead);
    await t.sendText(phone, reply);
    await linkWhatsappMessagesToLead(phone, lead);
    return;
  }

  // ── INTENT: new_enquiry ──────────────────────────────────────────────────
  if (intentResult.intent === "new_enquiry" && intentResult.confidence >= 0.7) {
    await logHandoffAndNotify(
      lead,
      "whatsapp_new_enquiry_intent",
      `${lead.name} may be interested in a new vehicle`,
      `Message: "${messageBody.slice(0, 200)}"${intentResult.staffSummary ? ` — ${intentResult.staffSummary}` : ""}`,
      `New vehicle interest: ${lead.name}`,
      intentResult.staffSummary ?? `Customer may want to enquire about a different vehicle.`,
    );
    // Start the new-enquiry confirmation step.
    await upsertConversation(lead.dealerId, phone, {
      step: "ni_confirm",
      name: lead.name,
      email: null,
      address: null,
      interestedVehicleId: null,
      menu: null,
    });
    await t.sendText(
      phone,
      `Hi ${firstName}! It sounds like you might be interested in a new vehicle enquiry. I can open a separate enquiry for you — your existing one won't be affected.\n\nWould you like to start a new enquiry? Reply *YES* to continue or *NO* to stay with your existing file.`,
    );
    await linkWhatsappMessagesToLead(phone, lead);
    return;
  }

  // ── INTENT: help / unclear / low-confidence ──────────────────────────────
  await logHandoffAndNotify(
    lead,
    "whatsapp_handoff",
    `WhatsApp message from ${lead.name} — advisor follow-up needed`,
    `Message: "${messageBody.slice(0, 200)}"${intentResult.staffSummary ? ` — ${intentResult.staffSummary}` : ""}`,
    `WhatsApp message: ${lead.name}`,
    `New WhatsApp message — please follow up.${intentResult.staffSummary ? " " + intentResult.staffSummary : ""}`,
  );
  await t.sendText(
    phone,
    `Hi ${firstName}! Thanks for your message. I've flagged this for your advisor and they'll follow up with you shortly.\n\nIf this is urgent, feel free to call us directly. We're here to help!`,
  );
  await linkWhatsappMessagesToLead(phone, lead);
}

/** Handle vehicle selection steps during new-enquiry intake (ni_brand / ni_model). */
async function handleNiVehicleStep(
  t: WhatsappTransport,
  lead: RepeatLeadRef,
  fakeConvo: WhatsappConversation,
  msg: InboundWhatsappMessage,
  originalStep: string,
): Promise<void> {
  const phone = msg.from;
  const firstName = (fakeConvo.name ?? lead.name).split(/\s+/)[0]!;

  if (fakeConvo.step === "brand") {
    const replyId = resolveMenuReply(fakeConvo, msg);
    if (replyId === OTHER_VEHICLE_ID) {
      await upsertConversation(lead.dealerId, phone, { step: "ni_model", brand: null, menu: null });
      await t.sendText(phone, "No problem — just type the make and model you're looking for.");
      return;
    }
    if (replyId && replyId.startsWith("brand_")) {
      await upsertConversation(lead.dealerId, phone, {
        step: "ni_model",
        brand: replyId.slice("brand_".length),
        menu: null,
      });
      await promptModel(
        t,
        lead.dealerId,
        phone,
        firstName,
        replyId.slice("brand_".length),
        "new_enquiry",
      );
      return;
    }
    const answer = (msg.text ?? msg.replyTitle ?? "").trim();
    if (answer) {
      const brands = await buildBrandRows(lead.dealerId);
      const hit = brands.find((b) => b.title.toLowerCase() === answer.toLowerCase());
      if (hit) {
        await upsertConversation(lead.dealerId, phone, {
          step: "ni_model",
          brand: hit.title,
          menu: null,
        });
        await promptModel(
          t,
          lead.dealerId,
          phone,
          firstName,
          hit.title,
          "new_enquiry",
        );
        return;
      }
      const matched = await matchVehicleByText(answer, lead.dealerId);
      await promptNiConfirmDetails(t, lead, fakeConvo, matched, answer, phone);
      return;
    }
    await t.sendText(phone, "Which brand are you interested in? Pick one from the list, or type the make and model.");
    return;
  }

  // step === "model"
  const replyId = resolveMenuReply(fakeConvo, msg);
  if (replyId === OTHER_VEHICLE_ID) {
    await upsertConversation(lead.dealerId, phone, { step: "ni_model", menu: null });
    await t.sendText(phone, "No problem — just type the make and model you're looking for.");
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
          eq(vehiclesTable.dealerId, lead.dealerId),
          eq(vehiclesTable.status, "available"),
          isNull(vehiclesTable.deletedAt),
        ),
      );
    if (v) {
      const vehicle: MatchedVehicle = {
        id: v.id,
        label: `${v.year} ${v.make} ${v.model}`,
        variant: v.trim || v.variant || null,
        color: v.exteriorColor || null,
      };
      await promptNiConfirmDetails(t, lead, fakeConvo, vehicle, null, phone);
      return;
    }
  }
  const answer = (msg.text ?? msg.replyTitle ?? "").trim();
  if (!answer) {
    await t.sendText(phone, "Which model are you interested in? Pick one from the list, or type the make and model.");
    return;
  }
  const matched =
    (await matchVehicleByText(
      fakeConvo.brand ? `${fakeConvo.brand} ${answer}` : answer,
      lead.dealerId,
    )) ?? (await matchVehicleByText(answer, lead.dealerId));
  await promptNiConfirmDetails(t, lead, fakeConvo, matched, answer, phone);
}

/** Show a confirmation summary before creating the new lead. */
async function promptNiConfirmDetails(
  t: WhatsappTransport,
  lead: RepeatLeadRef,
  convo: WhatsappConversation,
  vehicle: MatchedVehicle | null,
  freeText: string | null,
  phone: string,
): Promise<void> {
  await upsertConversation(lead.dealerId, phone, {
    step: "ni_confirm_details",
    interestedVehicleId: vehicle?.id ?? null,
    brand: vehicle ? null : freeText,
    menu: null,
  });
  const name = convo.name ?? lead.name;
  const vehicleDesc = vehicle ? vehicle.label : freeText ? `"${freeText}"` : "Not specified";
  await t.sendText(
    phone,
    `Please confirm these new enquiry details:\n\nName: ${name}\nEmail: ${convo.email || "Not provided"}\nAddress: ${convo.address || "Not provided"}\nVehicle: ${vehicleDesc}\n\nReply *YES* to submit, or *NO* to make changes.`,
  );
}

/** Complete the new-enquiry intake: create a separate lead, never modify the existing one. */
async function completeNewEnquiryFlow(
  t: WhatsappTransport,
  existingLead: RepeatLeadRef,
  convo: WhatsappConversation,
): Promise<void> {
  const phone = convo.phone;
  const [claimed] = await db
    .update(whatsappConversationsTable)
    .set({ step: "ni_creating", updatedAt: new Date() })
    .where(
      and(
        eq(whatsappConversationsTable.dealerId, existingLead.dealerId),
        eq(whatsappConversationsTable.phone, phone),
        eq(whatsappConversationsTable.step, "ni_confirm_details"),
      ),
    )
    .returning({ phone: whatsappConversationsTable.phone });
  if (!claimed) {
    await t.sendText(
      phone,
      "Your confirmed enquiry is already being processed. Your advisor will follow up shortly.",
    );
    return;
  }
  const name = convo.name ?? existingLead.name;
  const mobile = convo.mobile ?? `+${digits(phone)}`;

  let vehicle: MatchedVehicle | null = null;
  if (convo.interestedVehicleId) {
    const [v] = await db
      .select()
      .from(vehiclesTable)
      .where(
        and(
          eq(vehiclesTable.id, convo.interestedVehicleId),
          eq(vehiclesTable.dealerId, existingLead.dealerId),
          eq(vehiclesTable.status, "available"),
          isNull(vehiclesTable.deletedAt),
        ),
      );
    if (v) {
      vehicle = {
        id: v.id,
        label: [v.year, v.make, v.model].filter(Boolean).join(" "),
        variant: v.trim || v.variant || null,
        color: v.exteriorColor || null,
      };
    }
  }

  const newLead = await createConfirmedRepeatInboundLead(
    {
      dealerId: existingLead.dealerId,
      name,
      phone: mobile,
      email: convo.email ?? null,
      address: convo.address ?? null,
      channel: "social",
      source: "whatsapp",
      notes: [
        `New enquiry via WhatsApp concierge (repeat customer, existing lead #${existingLead.id}).`,
        !vehicle && convo.brand
          ? `Customer is interested in: ${convo.brand}.`
          : null,
      ]
        .filter(Boolean)
        .join("\n"),
      vehicle,
      channelLabel: "WhatsApp",
      actor: "AURA WhatsApp Bot",
    },
    existingLead.id,
  );

  await recordAgentRun({
    dealerId: existingLead.dealerId,
    agentKey: "intake_dedup",
    runType: "whatsapp_new_enquiry_intake",
    inputSource: "whatsapp",
    inputSummary: `Repeat customer confirmed new enquiry (existing lead #${existingLead.id})`,
    outputSummary: `Created new lead #${newLead.id} for repeat customer`,
    confidence: 1,
    refType: "lead",
    refId: newLead.id,
    mutation: true,
    changeSummary: `Repeat customer confirmed new vehicle enquiry → lead #${newLead.id} created`,
  });

  await endConversation(existingLead.dealerId, phone);

  const firstName = name.split(/\s+/)[0] ?? name;
  await t.sendText(
    phone,
    vehicle
      ? `Thanks ${firstName}! We've opened a new enquiry for the ${vehicle.label}. One of our advisors will be in touch shortly on ${mobile}.`
      : `Thanks ${firstName}! We've logged your new enquiry. One of our advisors will be in touch shortly on ${mobile}.`,
  );
  await linkWhatsappMessagesToLead(phone, newLead);
}

/**
 * Guided-bot entry point for one inbound customer message. Assumes
 * message-id dedupe has already happened. Never throws — failures are
 * logged and the webhook still 200s.
 */
export async function handleWhatsappMessage(
  rawTransport: WhatsappTransport,
  msg: InboundWhatsappMessage,
  dealerId: number,
): Promise<void> {
  const phone = msg.from;
  const t = rawTransport.durable
    ? rawTransport
    : recordingTransport(rawTransport, "AURA WhatsApp Bot", dealerId);
  try {
    // R6.4: STOP/START must always work — even when the bot is paused.
    const optReply = await handleOptKeyword(dealerId, phone, msg.text);
    if (optReply) {
      await recordWhatsappMessage({
        phone,
        direction: "in",
        body: msg.text ?? "",
        dealerId,
      });
      await (t.sendComplianceText ?? t.sendText)(phone, optReply);
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
    let convo = await activeConversation(dealerId, phone);
    let startedNewConversation = false;

    // If there is an active conversation in the ni_* steps, we are in a
    // repeat-customer new-enquiry intake. Route to handleRepeatCustomerMessage
    // with the existing lead as context.
    if (convo && convo.step.startsWith("ni_")) {
      const existing = await findOpenLeadByPhone(dealerId, phone);
      if (existing) {
        await handleRepeatCustomerMessage(t, existing, msg, convo);
        return;
      }
      // Orphaned ni_* convo (existing lead closed/deleted) — fall through to normal flow.
      await endConversation(dealerId, phone);
      convo = null;
    }

    if (!convo) {
      // Repeat message from someone with an open lead: route to intent-aware handler.
      const existing = await findOpenLeadByPhone(dealerId, phone);
      if (existing) {
        if (await handleTestDriveReminderReply(t, existing, msg)) return;
        await handleRepeatCustomerMessage(t, existing, msg, null);
        return;
      }

      // Fresh conversation: seed the session. The AI concierge can extract
      // multiple facts from the customer's opening message; the deterministic
      // flow remains the fallback when AI is unavailable.
      startedNewConversation = true;
      await upsertConversation(dealerId, phone, {
        step: "name",
        name: null,
        mobile: `+${digits(phone)}`,
        email: null,
        address: null,
        interestedVehicleId: null,
        menu: null,
        profileName: msg.profileName || null,
      });
      convo = await activeConversation(dealerId, phone);
      if (!convo) throw new Error("Failed to start WhatsApp conversation");
    }

    if (await handleAiLeadCapture(t, dealerId, convo, msg)) return;
    if (startedNewConversation) {
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
      await upsertConversation(dealerId, phone, {
        step: "email",
        name,
        mobile: `+${digits(phone)}`,
      });
      await promptEmail(t, dealerId, phone, name.split(/\s+/)[0]!, false);
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
        await promptMobile(t, dealerId, phone, (convo.name || "there").split(/\s+/)[0]!, true);
        return;
      }
      await upsertConversation(dealerId, phone, { step: "email", mobile });
      await promptEmail(
        t,
        dealerId,
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
        await promptEmail(t, dealerId, phone, firstName, true);
        return;
      }
      await upsertConversation(dealerId, phone, { email });
      await promptAddress(t, dealerId, phone, firstName);
      return;
    }

    if (convo.step === "address") {
      const replyId = resolveMenuReply(convo, msg);
      const firstNameA = (convo.name || "there").split(/\s+/)[0]!;
      const raw = (msg.text ?? "").trim();
      let address: string | null = null;
      if (replyId !== SKIP_ADDRESS_ID && !/^(skip|no|none)$/i.test(raw)) {
        if (raw.length >= 3) {
          address = raw.slice(0, 300);
        } else {
          await t.sendText(
            phone,
            "Sorry, I didn't catch that — could you type your address? Or reply Skip.",
          );
          return;
        }
      }
      await upsertConversation(dealerId, phone, { address });
      await promptBrand(t, dealerId, phone, firstNameA);
      return;
    }

    const firstName = (convo.name || "there").split(/\s+/)[0]!;

    if (convo.step === "brand") {
      const replyId = resolveMenuReply(convo, msg);
      if (replyId === OTHER_VEHICLE_ID) {
        await upsertConversation(dealerId, phone, { step: "model", brand: null, menu: null });
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
      await upsertConversation(dealerId, phone, { menu: null });
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
 *
 * dealerId must be passed from the resolved channel — never falls back to
 * defaultDealerId for Meta inbound messages.
 */
export async function handleWhatsappOneShot(
  rawTransport: WhatsappTransport,
  msg: InboundWhatsappMessage,
  dealerId: number,
): Promise<void> {
  const t = recordingTransport(rawTransport, "AURA WhatsApp Bot", dealerId);
  try {
    // R6.4: STOP/START must always work — even when the bot is paused.
    const optReply = await handleOptKeyword(dealerId, msg.from, msg.text);
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
      await handleRepeatCustomerMessage(t, existing, msg, null);
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
