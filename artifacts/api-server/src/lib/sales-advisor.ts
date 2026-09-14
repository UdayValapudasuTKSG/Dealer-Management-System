import { and, eq } from "drizzle-orm";
import {
  db,
  dealerUsersTable,
  usersTable,
  type Lead,
} from "@workspace/db";

/**
 * The advisor printed on a quote is the lead owner, not the user who
 * generated/downloaded the quote.  `assignedTo` predates user ownership and
 * is only a safe fallback for rows which have no owner id at all.
 */
export type SalesAdvisorLead = Pick<
  Lead,
  "dealerId" | "ownerUserId" | "assignedTo"
>;

export function normalizeSalesAdvisorName(
  name: string | null | undefined,
): string {
  // Historical assignment code sometimes copied an email or "User #123"
  // placeholder into assignedTo. Those are not names and must not become
  // customer-facing identity disclosures. The same guard applies to
  // users.name: imported/legacy user records can contain those placeholders.
  const normalized = typeof name === "string" ? name.trim() : "";
  if (
    normalized.includes("@") ||
    /^\d+$/.test(normalized) ||
    /^user\s*#?\s*\d+$/i.test(normalized)
  ) {
    return "";
  }
  return normalized;
}

/**
 * Pure selection rule kept separate from the membership lookup so the
 * legacy/empty-name cases can be regression-tested without writing to a
 * production database.
 *
 * An owner id is authoritative.  In particular, do not fall back to a
 * possibly stale legacy label when an owner exists but is no longer a member
 * of this dealer or has no display name.  Never substitute an email address
 * or a numeric identifier for a missing name.
 */
export function selectSalesAdvisorName(
  lead: SalesAdvisorLead,
  authorizedOwnerName: string | null | undefined,
): string {
  if (lead.ownerUserId != null) {
    return normalizeSalesAdvisorName(authorizedOwnerName);
  }
  return normalizeSalesAdvisorName(lead.assignedTo);
}

/** Add the immutable advisor snapshot to a newly queued PDF payload. */
export function snapshotSalesAdvisorPayload(
  payload: Record<string, string>,
  advisorName: string | null | undefined,
): Record<string, string> {
  return {
    ...payload,
    // Deliberately retain the key when unassigned: queue replay must not
    // resolve a later/current owner.
    salesAdvisorName: normalizeSalesAdvisorName(advisorName),
  };
}

/**
 * Historical queue payloads predate the snapshot key. Enrich a copy only
 * while the key is absent; an existing empty value is an intentional
 * snapshot and must remain empty.
 */
export function enrichLegacySalesAdvisorPayload(
  payload: Record<string, string>,
  advisorName: string | null | undefined,
): Record<string, string> {
  if (Object.prototype.hasOwnProperty.call(payload, "salesAdvisorName")) {
    return { ...payload };
  }
  return snapshotSalesAdvisorPayload(payload, advisorName);
}

/**
 * Resolve the assigned owner through this dealer's membership before exposing
 * the user's full display name.  Scoping both sides of the join prevents a
 * user id belonging to another dealer from leaking into a quote payload.
 */
export type SalesAdvisorOwnerLookup = (
  dealerId: number,
  ownerUserId: number,
) => Promise<string | null | undefined>;

export const lookupSalesAdvisorOwnerName: SalesAdvisorOwnerLookup = async (
  dealerId,
  ownerUserId,
): Promise<string | null> => {
  const [owner] = await db
    .select({ name: usersTable.name })
    .from(dealerUsersTable)
    .innerJoin(usersTable, eq(dealerUsersTable.userId, usersTable.id))
    .where(
      and(
        eq(dealerUsersTable.dealerId, dealerId),
        eq(dealerUsersTable.userId, ownerUserId),
      ),
    )
    .limit(1);
  return owner?.name ?? null;
};

export async function resolveSalesAdvisorName(
  lead: SalesAdvisorLead,
  lookupOwnerName: SalesAdvisorOwnerLookup = lookupSalesAdvisorOwnerName,
): Promise<string> {
  if (lead.ownerUserId == null) {
    return selectSalesAdvisorName(lead, null);
  }

  return selectSalesAdvisorName(
    lead,
    await lookupOwnerName(lead.dealerId, lead.ownerUserId),
  );
}
