import { and, eq } from "drizzle-orm";
import { db, leadsTable } from "@workspace/db";
import { isCallCentreRole } from "./call-centre-policy";

type ActingUser = {
  id: number;
  name: string | null;
  roleName: string | null;
};

type LeadOwnership = {
  ownerUserId: number | null;
  assignedTo: string | null;
};

/** Roles whose lead mutations are restricted to leads assigned to them. */
export function isOwnRestrictedRole(user: ActingUser | undefined): boolean {
  return user?.roleName === "Sales Advisor" || isCallCentreRole(user?.roleName);
}

/** True when the lead is assigned to this user (owner id, or legacy
 *  name-only assignment when no owner id is stamped). */
export function ownsLead(user: ActingUser, lead: LeadOwnership): boolean {
  if (lead.ownerUserId === user.id) return true;
  const myName = (user.name ?? "").trim().toLowerCase();
  return (
    lead.ownerUserId == null &&
    myName !== "" &&
    (lead.assignedTo ?? "").trim().toLowerCase() === myName
  );
}

/**
 * Ownership check for lead-linked mutations (test drives, bookings, deals,
 * and every /leads/:id write): Sales Advisors may only mutate leads
 * assigned to them.
 *
 * Returns:
 * - "ok"        — mutation may proceed (role unrestricted, or lead owned)
 * - "forbidden" — restricted role acting on someone else's lead → 403
 * - "missing"   — lead not found in this dealership (caller's own 404 path)
 */
export async function checkLeadMutationOwnership(
  user: ActingUser | undefined,
  dealerId: number,
  leadId: number,
): Promise<"ok" | "forbidden" | "missing"> {
  if (!user || !isOwnRestrictedRole(user)) return "ok";
  const [lead] = await db
    .select({
      ownerUserId: leadsTable.ownerUserId,
      assignedTo: leadsTable.assignedTo,
    })
    .from(leadsTable)
    .where(and(eq(leadsTable.id, leadId), eq(leadsTable.dealerId, dealerId)));
  if (!lead) return "missing";
  return ownsLead(user, lead) ? "ok" : "forbidden";
}

export const LEAD_NOT_OWNED = {
  error: "You can only edit leads assigned to you",
  code: "lead_not_owned",
} as const;
