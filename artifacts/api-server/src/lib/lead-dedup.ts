import { and, eq, isNull, notInArray } from "drizzle-orm";
import {
  db,
  leadsTable,
  vehiclesTable,
  timelineEventsTable,
  activityTable,
  type Lead,
} from "@workspace/db";
import { normalizeWhatsappPhone } from "./whatsapp-phone";

// ---------------------------------------------------------------------------
// Dedup agent (A1) — deterministic duplicate detection at lead creation.
//
// A new lead is a duplicate of an OPEN lead (phase not won/lost) on the same
// dealer when the normalized full name matches AND at least one hard contact
// point (phone digits or lowercased email) matches. Instead of creating a
// second record, the new interest is appended to the existing lead and a
// timeline receipt is written.
// ---------------------------------------------------------------------------

const AGENT_ACTOR = "AURA Dedup Agent";

const normName = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");
const normPhone = (s: string | null | undefined): string =>
  normalizeWhatsappPhone(s ?? "") ?? "";
const normEmail = (s: string | null | undefined): string =>
  (s ?? "").trim().toLowerCase();

export type DedupCandidate = {
  name: string;
  email?: string | null;
  phone?: string | null;
  interestedVehicleId?: number | null;
  variant?: string | null;
  color?: string | null;
  notes?: string | null;
  /**
   * R10.3 consent captured with this submission (per-channel). On merge it is
   * carried forward ONLY for channels with no existing entry — an existing
   * consent decision is never upgraded by a later submission.
   */
  marketingConsent?: Record<
    string,
    { granted: boolean; basis: string; capturedAt: string; sourceEvent: string }
  > | null;
};

/**
 * Find an open lead that deterministically matches phone/email.
 * Default mode also requires a name match (website forms, where the
 * submitter types their own name). Webhook channels (Meta Lead Ads,
 * WhatsApp) pass `contactOnly: true` because their names are often
 * placeholders ("WhatsApp +592…", profile names) — there a hard contact
 * point match (normalized email OR phone digits) alone is decisive.
 */
export async function findOpenDuplicate(
  dealerId: number,
  input: DedupCandidate,
  opts?: { contactOnly?: boolean },
): Promise<Lead | null> {
  const name = normName(input.name);
  const phone = normPhone(input.phone);
  const email = normEmail(input.email);
  if (!phone && !email) return null;
  if (!opts?.contactOnly && !name) return null;

  const open = await db
    .select()
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.dealerId, dealerId),
        notInArray(leadsTable.phase, ["won", "lost"]),
        // Soft-deleted leads never absorb new enquiries — deleting a lead
        // frees its phone/email for a fresh capture.
        isNull(leadsTable.deletedAt),
      ),
    );

  return (
    open.find((l) => {
      if (!opts?.contactOnly && normName(l.name) !== name) return false;
      const lp = normPhone(l.phone);
      const phoneHit = !!phone && !!lp && lp === phone;
      const emailHit = !!email && normEmail(l.email) === email;
      return phoneHit || emailHit;
    }) ?? null
  );
}

/**
 * Merge a duplicate submission into the existing open lead: append the newly
 * interested model(s) and notes, log a timeline receipt + agent activity.
 * Returns the refreshed lead and a human-readable notice.
 */
export async function mergeIntoExistingLead(
  existing: Lead,
  input: DedupCandidate,
  actor: string,
): Promise<{ lead: Lead; notice: string }> {
  const additions: string[] = [];
  const patch: Partial<typeof leadsTable.$inferInsert> = {};

  let newVehicleLabel: string | null = null;
  if (
    input.interestedVehicleId &&
    input.interestedVehicleId !== existing.interestedVehicleId
  ) {
    const [v] = await db
      .select()
      .from(vehiclesTable)
      .where(
        and(
          eq(vehiclesTable.id, input.interestedVehicleId),
          eq(vehiclesTable.dealerId, existing.dealerId),
        ),
      );
    if (v) {
      newVehicleLabel = `${v.year} ${v.make} ${v.model}`;
      if (!existing.interestedVehicleId) {
        // No model on file yet — the new interest becomes the primary one.
        patch.interestedVehicleId = v.id;
        if (input.variant) patch.variant = input.variant;
        if (input.color) patch.color = input.color;
        additions.push(`interested model set to ${newVehicleLabel}`);
      } else {
        // Keep the primary model; record the additional interest on the record.
        const line = `Also interested in: ${newVehicleLabel}${input.variant ? ` (${input.variant})` : ""}`;
        patch.notes = existing.notes ? `${existing.notes}\n${line}` : line;
        additions.push(`added interest in ${newVehicleLabel}`);
      }
    }
  }

  if (input.notes && input.notes.trim()) {
    const base = patch.notes ?? existing.notes;
    patch.notes = base ? `${base}\n${input.notes.trim()}` : input.notes.trim();
  }
  // Fill in any missing contact point from the new submission.
  if (!existing.email && input.email) patch.email = input.email;
  if (!existing.phone && input.phone) patch.phone = input.phone;

  // R10.3: carry consent forward per channel; NEVER overwrite an existing
  // entry (a prior opt-out cannot be upgraded by a later form submission).
  if (input.marketingConsent) {
    const current = existing.marketingConsent ?? {};
    const added: typeof current = {};
    for (const [channel, entry] of Object.entries(input.marketingConsent)) {
      if (!(channel in current)) added[channel] = entry;
    }
    if (Object.keys(added).length > 0) {
      patch.marketingConsent = { ...current, ...added };
    }
  }

  let lead = existing;
  if (Object.keys(patch).length > 0) {
    const [updated] = await db
      .update(leadsTable)
      .set(patch)
      .where(
        and(
          eq(leadsTable.id, existing.id),
          eq(leadsTable.dealerId, existing.dealerId),
        ),
      )
      .returning();
    if (updated) lead = updated;
  }

  const detailBits =
    additions.length > 0
      ? additions.join("; ")
      : "no new vehicle interest — contact details matched an open enquiry";
  const notice = `Matched existing open lead for ${existing.name} — ${
    newVehicleLabel
      ? `their interest in the ${newVehicleLabel} was added to it`
      : "the enquiry was merged into it"
  } instead of creating a duplicate.`;

  await db.insert(timelineEventsTable).values({
    dealerId: lead.dealerId,
    customerId: lead.customerId,
    domain: "leads",
    kind: "lead_merged",
    title: "Duplicate enquiry merged",
    detail: `A new enquiry (via ${actor}) matched this open lead by name and contact details — ${detailBits}.`,
    actor: AGENT_ACTOR,
    isAgent: true,
    refType: "lead",
    refId: lead.id,
  });

  await db.insert(activityTable).values({
    dealerId: lead.dealerId,
    agentKey: "intake_dedup",
    actor: AGENT_ACTOR,
    isAi: true,
    action: "Merged duplicate lead",
    entity: lead.name,
    detail: detailBits,
  });

  return { lead, notice };
}
