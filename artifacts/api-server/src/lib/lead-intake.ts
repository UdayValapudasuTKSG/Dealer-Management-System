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

export async function createInboundLead(opts: {
  dealerId: number;
  name: string;
  email?: string | null;
  phone?: string | null;
  channel: string;
  source: string;
  notes?: string | null;
  vehicle?: MatchedVehicle | null;
  /** Human label for the channel, used in timeline copy ("Facebook Lead Ad") */
  channelLabel: string;
  /** Timeline actor name ("Meta Lead Ads" / "WhatsApp") */
  actor: string;
}): Promise<Lead> {
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

  const [lead] = await db
    .insert(leadsTable)
    .values({
      dealerId: opts.dealerId,
      name: opts.name,
      email: opts.email ?? null,
      phone: opts.phone ?? null,
      channel: opts.channel,
      source: opts.source,
      priority: "medium",
      phase: "new",
      status: "new",
      interestedVehicleId: opts.vehicle?.id ?? null,
      variant: opts.vehicle?.variant ?? null,
      color: opts.vehicle?.color ?? null,
      notes: opts.notes ?? null,
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

  // Quote (when a vehicle was matched to inventory) or welcome email.
  onLeadCreated(lead!);
  // Quote agent (A3): auto-generate the versioned Code.
  autoQuoteOnLeadCreated(lead!);

  // Sales agent routes the lead to the least-loaded advisor automatically.
  const assigned = await autoAssignLead(lead!);

  // Intake agent: nearest showroom + WhatsApp quote share (fire-and-forget).
  runIntakeOrchestration(assigned ?? lead!);

  // R6.2 #1 New Lead → division sales managers (In-App + Email, deduped on
  // the lead) — replaces the old ad-hoc coordinator broadcast.
  notifyLeadNew(lead!);

  return assigned ?? lead!;
}
