import { and, eq, gt, isNotNull, notInArray } from "drizzle-orm";
import {
  db,
  leadsTable,
  timelineEventsTable,
  vehiclesTable,
  whatsappConversationsTable,
  type WhatsappConversation,
} from "@workspace/db";
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

// ---------------------------------------------------------------------------
// WhatsApp guided lead-capture bot — deterministic state machine, shared by
// both channels (Meta Cloud API and Twilio) via a transport abstraction.
// greet → name → mobile ("use this number") → vehicle (inventory pick with
// free-text fallback) → lead created via shared intake.
//
// Interactive transports (Meta) get native reply buttons and list messages;
// text-only transports (Twilio/TwiML) get numbered menus — the presented
// option ids are persisted on the conversation row so a numeric reply can be
// mapped back to the option it referred to.
// ---------------------------------------------------------------------------

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // half-finished chats expire after 24h
const USE_THIS_NUMBER_ID = "use_this_number";
const OTHER_VEHICLE_ID = "veh_other";
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
    profileName: string | null;
    menu: string | null;
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
  await db
    .delete(whatsappConversationsTable)
    .where(eq(whatsappConversationsTable.phone, phone));
}

/** Map a bare numeric reply ("2") to the option id it referred to, using the
 * menu persisted when the options were presented (text-only transports). */
function resolveMenuReply(
  convo: WhatsappConversation,
  msg: InboundWhatsappMessage,
): string | null {
  if (msg.replyId) return msg.replyId;
  const t = (msg.text ?? "").trim();
  if (!/^\d{1,2}$/.test(t) || !convo.menu) return null;
  try {
    const ids = JSON.parse(convo.menu) as string[];
    return ids[Number(t) - 1] ?? null;
  } catch {
    return null;
  }
}

async function buildVehicleRows(dealerId: number): Promise<WhatsappListRow[]> {
  const vehicles = await db
    .select()
    .from(vehiclesTable)
    .where(
      and(
        eq(vehiclesTable.dealerId, dealerId),
        eq(vehiclesTable.status, "available"),
      ),
    );
  // WhatsApp lists cap at 10 rows: up to 9 vehicles + an "Other" fallback.
  // Collapse duplicates of the same model so the list covers more range.
  const seen = new Set<string>();
  const rows: WhatsappListRow[] = [];
  for (const v of vehicles) {
    const key = `${v.make} ${v.model} ${v.trim ?? v.variant ?? ""}`.trim();
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

async function promptVehicle(
  t: WhatsappTransport,
  dealerId: number,
  phone: string,
  firstName: string,
): Promise<void> {
  const rows = await buildVehicleRows(dealerId);
  if (rows.length === 0) {
    // No inventory to list — fall back to free text.
    await upsertConversation(phone, { menu: null });
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
    menu: JSON.stringify(rows.map((r) => r.id)),
  });
  if (t.interactive) {
    await t.sendList(phone, {
      body: `Thanks ${firstName}! Which model are you interested in? Tap below to browse our current showroom.`,
      buttonLabel: "View models",
      sectionTitle: "Available models",
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
    `Thanks ${firstName}! Which model are you interested in? Reply with a number:\n\n${lines.join(
      "\n",
    )}\n\nOr just type the make and model.`,
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
    channel: "social",
    source: "whatsapp",
    notes: noteParts.join("\n"),
    vehicle,
    channelLabel: "WhatsApp",
    actor: "AURA WhatsApp Bot",
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
      await upsertConversation(phone, { step: "vehicle", mobile });
      await promptVehicle(
        t,
        dealerId,
        phone,
        (convo.name || "there").split(/\s+/)[0]!,
      );
      return;
    }

    // step === "vehicle"
    const replyId = resolveMenuReply(convo, msg);
    if (replyId && replyId.startsWith("veh_")) {
      if (replyId === OTHER_VEHICLE_ID) {
        await upsertConversation(phone, { menu: null });
        await t.sendText(
          phone,
          "No problem — just type the make and model you're looking for.",
        );
        return;
      }
      const vehicleId = Number(replyId.slice("veh_".length));
      const [v] = await db
        .select()
        .from(vehiclesTable)
        .where(
          and(
            eq(vehiclesTable.id, vehicleId),
            eq(vehiclesTable.dealerId, dealerId),
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
    const matched = await matchVehicleByText(answer, dealerId);
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
    await recordWhatsappMessage({
      phone: msg.from,
      direction: "in",
      body: msg.text || msg.replyTitle || "",
      dealerId,
    });
    const existing = await findOpenLeadByPhone(dealerId, msg.from);
    if (existing) {
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
