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

/** Match a free-text vehicle mention against inventory (same heuristics as
 * the website enquiry fallback). */
export async function matchVehicleByText(
  text: string | null | undefined,
  dealerId: number,
): Promise<MatchedVehicle | null> {
  if (!text || !text.trim()) return null;
  const vehicles = await db
    .select()
    .from(vehiclesTable)
    .where(eq(vehiclesTable.dealerId, dealerId));
  const needle = text.trim().toLowerCase();
  const match = vehicles.find((v) => {
    const full = `${v.year} ${v.make} ${v.model}`.toLowerCase();
    const short = `${v.make} ${v.model}`.toLowerCase();
    return (
      full.includes(needle) || short.includes(needle) || needle.includes(short)
    );
  });
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
