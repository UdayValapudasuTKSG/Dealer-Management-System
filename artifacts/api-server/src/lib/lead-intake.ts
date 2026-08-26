import { and, eq } from "drizzle-orm";
import {
  db,
  leadsTable,
  vehiclesTable,
  timelineEventsTable,
  type Lead,
} from "@workspace/db";
import { notifyLeadNew } from "./notify-triggers";
import { onLeadCreated } from "./email-triggers";
import { autoAssignLead } from "./lead-assignment";
import { findOpenDuplicate, mergeIntoExistingLead } from "./lead-dedup";
import { notifyUser } from "./email";
import { runIntakeOrchestration } from "./intake-orchestration";
import { autoQuoteOnLeadCreated } from "./quotes";

import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Shared inbound lead intake — used by the public webhook channels (Meta Lead
// Ads, WhatsApp) so they fire the exact same side-effects as web enquiries:
// timeline event, coordinator/manager notifications, lifecycle email/quote.
// ---------------------------------------------------------------------------

export type MatchedVehicle = {
  id: number;
  label: string;
  variant: string | null;
  color: string | null;
};

/** Normalize free text / form-option slugs for inventory matching: lowercase,
 * strip every non-alphanumeric character (spaces, underscores, dashes, dots),
 * so "sealion_7" ≡ "SEALION 7" and "yuan_plus_-_480_gs" ≡ "Yuan Plus - 480 GS". */
export function normalizeVehicleText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function tokenizeVehicleText(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

type VehicleRow = {
  id: number;
  year: number;
  make: string;
  model: string;
  trim: string | null;
  variant: string | null;
  exteriorColor: string | null;
};

/** Token-prefix fallback for marketing-name drift ("sealion_7" vs inventory
 * model "SEALION EV"): strip make tokens from the answer, score each distinct
 * model by how many of its leading tokens the answer starts with, and accept
 * only a strictly unique best-scoring model (>= 1 alphabetic token). Among the
 * units of the winning model, prefer one whose variant/trim tokens also appear
 * in the answer (e.g. "yuan_plus_-_480_gs" -> variant "480KM-GS"). */
function matchByTokenPrefix<T extends VehicleRow>(
  text: string,
  vehicles: T[],
): T | null {
  const makeTokens = new Set(
    vehicles.flatMap((v) => tokenizeVehicleText(v.make)),
  );
  const needleTokens = tokenizeVehicleText(text).filter(
    (t) => !makeTokens.has(t),
  );
  if (needleTokens.length === 0) return null;

  const scoreModel = (model: string): number => {
    const modelTokens = tokenizeVehicleText(model);
    let score = 0;
    while (
      score < modelTokens.length &&
      score < needleTokens.length &&
      modelTokens[score] === needleTokens[score]
    ) {
      score++;
    }
    // Require at least one alphabetic token in the shared prefix — a bare
    // numeric overlap ("7") is not a confident model identification.
    const prefix = modelTokens.slice(0, score);
    if (!prefix.some((t) => /[a-z]/.test(t) && t.length >= 3)) return 0;
    return score;
  };

  const byModel = new Map<string, { score: number; units: T[] }>();
  for (const v of vehicles) {
    const key = normalizeVehicleText(v.model);
    let entry = byModel.get(key);
    if (!entry) {
      entry = { score: scoreModel(v.model), units: [] };
      byModel.set(key, entry);
    }
    entry.units.push(v);
  }
  let best: { score: number; units: T[] } | null = null;
  let tied = false;
  for (const entry of byModel.values()) {
    if (entry.score === 0) continue;
    if (!best || entry.score > best.score) {
      best = entry;
      tied = false;
    } else if (entry.score === best.score) {
      tied = true;
    }
  }
  if (!best || tied) return null;

  // Prefer the unit whose variant/trim tokens overlap the answer the most.
  const needleSet = new Set(needleTokens);
  let bestUnit = best.units[0]!;
  let bestOverlap = 0;
  for (const unit of best.units) {
    const variantTokens = tokenizeVehicleText(
      `${unit.trim ?? ""} ${unit.variant ?? ""}`,
    );
    const overlap = variantTokens.filter((t) => needleSet.has(t)).length;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestUnit = unit;
    }
  }
  return bestUnit;
}

/** Match a free-text vehicle mention against inventory (same heuristics as
 * the website enquiry fallback). Meta lead forms often return raw option
 * slugs ("sealion_7"), so comparison happens on normalized strings. */
export async function matchVehicleByText(
  text: string | null | undefined,
  dealerId: number,
): Promise<MatchedVehicle | null> {
  if (!text || !text.trim()) return null;
  const needle = normalizeVehicleText(text);
  // Too-short needles ("7", "gs") would substring-match half the inventory.
  if (needle.length < 3) return null;
  const vehicles = await db
    .select()
    .from(vehiclesTable)
    .where(eq(vehiclesTable.dealerId, dealerId))
    .orderBy(vehiclesTable.id);
  let match = vehicles.find((v) => {
    const full = normalizeVehicleText(`${v.year} ${v.make} ${v.model}`);
    const short = normalizeVehicleText(`${v.make} ${v.model}`);
    const model = normalizeVehicleText(v.model);
    return (
      full.includes(needle) ||
      short.includes(needle) ||
      needle.includes(short) ||
      (model.length >= 3 && needle.includes(model))
    );
  });
  // Fallback for marketing-name drift ("sealion_7" vs inventory "SEALION EV"):
  // score each distinct model by how many of its leading tokens the answer
  // starts with (make tokens stripped), and accept only a strictly unique best.
  if (!match) match = matchByTokenPrefix(text, vehicles) ?? undefined;
  if (!match) return null;
  return {
    id: match.id,
    label: `${match.year} ${match.make} ${match.model}`,
    variant: match.trim || match.variant || null,
    color: match.exteriorColor || null,
  };
}

export type InboundLeadOptions = {
  dealerId: number;
  name: string;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  channel: string;
  source: string;
  notes?: string | null;
  vehicle?: MatchedVehicle | null;
  /** Free-text model the customer asked about when no inventory unit matched. */
  interestedModelText?: string | null;
  /** Human label for the channel, used in timeline copy ("Facebook Lead Ad") */
  channelLabel: string;
  /** R10.3 consent captured at intake (per-channel); carried through dedup. */
  marketingConsent?: Record<
    string,
    { granted: boolean; basis: string; capturedAt: string; sourceEvent: string }
  > | null;
  /** Timeline actor name ("Meta Lead Ads" / "WhatsApp") */
  actor: string;
};

// R10.3: an inbound WhatsApp contact is an explicit opt-in for the WhatsApp
// channel only (never inferred for email).
function intakeConsent(opts: InboundLeadOptions) {
  if (opts.marketingConsent) return opts.marketingConsent;
  if (opts.channel === "whatsapp" && opts.phone) {
    return {
      whatsapp: {
        granted: true,
        basis: "whatsapp_inbound_optin",
        capturedAt: new Date().toISOString(),
        sourceEvent: `whatsapp:${opts.phone}`,
      },
    };
  }
  return null;
}

async function createNewInboundLead(opts: InboundLeadOptions): Promise<Lead> {
  const [lead] = await db
    .insert(leadsTable)
    .values({
      dealerId: opts.dealerId,
      name: opts.name,
      email: opts.email ?? null,
      phone: opts.phone ?? null,
      address: opts.address ?? null,
      channel: opts.channel,
      source: opts.source,
      priority: "medium",
      phase: "new",
      status: "new",
      interestedVehicleId: opts.vehicle?.id ?? null,
      interestedModelText: opts.vehicle ? null : (opts.interestedModelText ?? null),
      variant: opts.vehicle?.variant ?? null,
      color: opts.vehicle?.color ?? null,
      notes: opts.notes ?? null,
      marketingConsent: intakeConsent(opts),
    })
    .returning();

  await db.insert(timelineEventsTable).values({
    dealerId: opts.dealerId,
    customerId: lead!.customerId,
    domain: "leads",
    kind: "enquiry_received",
    title: `Enquiry received from ${opts.name}`,
    detail: opts.vehicle
      ? `${opts.channelLabel} enquiry for the ${opts.vehicle.label}. Awaiting coordinator review.`
      : `${opts.channelLabel} enquiry captured. Awaiting coordinator review.`,
    actor: opts.actor,
    isAgent: true,
    refType: "lead",
    refId: lead!.id,
  });

  onLeadCreated(lead!);
  autoQuoteOnLeadCreated(lead!);
  const assigned = await autoAssignLead(lead!);
  runIntakeOrchestration(assigned ?? lead!);
  notifyLeadNew(lead!);
  return assigned ?? lead!;
}

export async function createInboundLead(
  opts: InboundLeadOptions,
): Promise<Lead> {
  // Dedup agent (A1): a matching open lead (normalized email OR phone within
  // this dealer) absorbs the enquiry instead of creating a duplicate.
  const duplicate = await findOpenDuplicate(
    opts.dealerId,
    {
      name: opts.name,
      email: opts.email,
      phone: opts.phone,
      interestedVehicleId: opts.vehicle?.id ?? null,
      variant: opts.vehicle?.variant ?? null,
      color: opts.vehicle?.color ?? null,
      notes: opts.notes ?? null,
    },
    { contactOnly: true },
  );
  if (duplicate) {
    const { lead: merged } = await mergeIntoExistingLead(
      duplicate,
      {
        name: opts.name,
        email: opts.email,
        phone: opts.phone,
        interestedVehicleId: opts.vehicle?.id ?? null,
        variant: opts.vehicle?.variant ?? null,
        color: opts.vehicle?.color ?? null,
        notes: opts.notes
          ? `${opts.channelLabel} enquiry:\n${opts.notes}`
          : `Repeat enquiry via ${opts.channelLabel}.`,
        marketingConsent: intakeConsent(opts),
      },
      opts.channelLabel,
    );
    if (merged.ownerUserId) {
      try {
        await notifyUser({
          userId: merged.ownerUserId,
          dealerId: merged.dealerId,
          type: "system",
          title: `Repeat enquiry: ${merged.name}`,
          body: `A new ${opts.channelLabel} enquiry matched this open lead and was merged into it.`,
          link: `/lead/${merged.id}`,
        });
      } catch (err) {
        logger.error({ err }, "Failed to notify owner of merged enquiry");
      }
    }
    return merged;
  }

  return createNewInboundLead(opts);
}

/**
 * Narrow bypass for the repeat-customer concierge after its explicit final
 * confirmation. Ordinary intake must continue through createInboundLead so
 * contact deduplication remains mandatory everywhere else.
 */
export async function createConfirmedRepeatInboundLead(
  opts: InboundLeadOptions,
  originLeadId: number,
): Promise<Lead> {
  const [origin] = await db
    .select({ id: leadsTable.id })
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.id, originLeadId),
        eq(leadsTable.dealerId, opts.dealerId),
      ),
    );
  if (!origin) throw new Error("Origin lead is unavailable for repeat enquiry");
  const lead = await createNewInboundLead(opts);
  await db.insert(timelineEventsTable).values({
    dealerId: opts.dealerId,
    customerId: lead.customerId,
    domain: "leads",
    kind: "confirmed_repeat_enquiry",
    title: "Separate enquiry confirmed by customer",
    detail: `Customer explicitly confirmed a separate WhatsApp enquiry from lead #${originLeadId}.`,
    actor: opts.actor,
    isAgent: true,
    refType: "lead",
    refId: lead.id,
  });
  return lead;
}
