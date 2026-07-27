import { and, eq } from "drizzle-orm";
import { db, dealerUsersTable } from "@workspace/db";
import type { AuthedUser } from "../middlewares/rbac";

/**
 * Persona tiers for reports & dashboards (R5):
 *  - leadership: super admins / General Managers — dealer-wide, both divisions
 *  - manager: any "* Manager" role — pre-scoped to their dealer_users.divisionId
 *  - advisor: everyone else — records assigned to them only
 */
export type PersonaTier = "leadership" | "manager" | "advisor";

export type PersonaScope = {
  tier: PersonaTier;
  userId: number;
  nameKey: string | null;
  /** Manager's own division (null = no division on file → dealer-wide). */
  divisionId: number | null;
};

export async function resolvePersonaScope(
  user: AuthedUser,
  dealerId: number,
): Promise<PersonaScope> {
  const nameKey = user.name?.trim().toLowerCase() || null;
  const [membership] = await db
    .select({
      divisionId: dealerUsersTable.divisionId,
      isGeneralManager: dealerUsersTable.isGeneralManager,
    })
    .from(dealerUsersTable)
    .where(
      and(
        eq(dealerUsersTable.dealerId, dealerId),
        eq(dealerUsersTable.userId, user.id),
      ),
    );
  const roleName = user.roleName ?? "";
  if (
    user.isSuperAdmin ||
    membership?.isGeneralManager ||
    roleName === "General Manager" ||
    roleName === "Leadership"
  ) {
    return { tier: "leadership", userId: user.id, nameKey, divisionId: null };
  }
  if (/manager/i.test(roleName)) {
    return {
      tier: "manager",
      userId: user.id,
      nameKey,
      divisionId: membership?.divisionId ?? null,
    };
  }
  return {
    tier: "advisor",
    userId: user.id,
    nameKey,
    divisionId: membership?.divisionId ?? null,
  };
}

/** Match by user ID first; fall back to display name for legacy rows. */
export function assignedToMe(
  scope: PersonaScope,
  assigneeUserId: number | null | undefined,
  assigneeName: string | null | undefined,
): boolean {
  if (assigneeUserId != null) return assigneeUserId === scope.userId;
  return (
    scope.nameKey != null &&
    (assigneeName ?? "").trim().toLowerCase() === scope.nameKey
  );
}

/** Division filter for manager tier (and explicit divisionId query filter). */
export function divisionMatch(
  scope: PersonaScope,
  requestedDivisionId: number | null,
  rowDivisionId: number | null | undefined,
): boolean {
  if (requestedDivisionId != null && rowDivisionId !== requestedDivisionId)
    return false;
  if (scope.tier === "manager" && scope.divisionId != null)
    return rowDivisionId === scope.divisionId;
  return true;
}

export const scopeLeadRows = <
  T extends {
    ownerUserId: number | null;
    assignedTo: string | null;
    divisionId: number | null;
  },
>(
  scope: PersonaScope,
  rows: T[],
  requestedDivisionId: number | null = null,
): T[] =>
  rows.filter((l) => {
    if (!divisionMatch(scope, requestedDivisionId, l.divisionId)) return false;
    if (scope.tier === "advisor")
      return assignedToMe(scope, l.ownerUserId, l.assignedTo);
    return true;
  });

export const scopeDealRows = <
  T extends {
    salesAdvisorUserId: number | null;
    salesAdvisor: string | null;
    divisionId: number | null;
  },
>(
  scope: PersonaScope,
  rows: T[],
  requestedDivisionId: number | null = null,
): T[] =>
  rows.filter((d) => {
    if (!divisionMatch(scope, requestedDivisionId, d.divisionId)) return false;
    if (scope.tier === "advisor")
      return assignedToMe(scope, d.salesAdvisorUserId, d.salesAdvisor);
    return true;
  });

/* ------------------------------------------------------------------ */
/* Guyana-local time + GYD money helpers (server-side serialization)   */
/* ------------------------------------------------------------------ */

const GUYANA_OFFSET_MS = 4 * 60 * 60 * 1000; // GMT-4, no DST

/** Shift a UTC instant so UTC getters read Guyana wall-clock values. */
export function toGuyana(d: Date | string): Date {
  return new Date(new Date(d).getTime() - GUYANA_OFFSET_MS);
}

export function guyanaMonthKey(d: Date | string): string {
  const g = toGuyana(d);
  return `${g.getUTCFullYear()}-${g.getUTCMonth()}`;
}

export function guyanaDateLabel(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const g = toGuyana(d);
  return g.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Parse a YYYY-MM-DD range as Guyana-local day boundaries (UTC-4). */
export function parseGuyanaRange(fromRaw?: string, toRaw?: string) {
  const to = toRaw
    ? new Date(`${toRaw}T23:59:59.999-04:00`)
    : new Date();
  const from = fromRaw
    ? new Date(`${fromRaw}T00:00:00.000-04:00`)
    : new Date(new Date(to).setMonth(to.getMonth() - 6));
  return { from, to };
}

/** GYD money formatter from stored USD-scale amounts. */
export function makeGyd(usdExchangeRate: number | null | undefined) {
  const rate = usdExchangeRate ?? 209;
  return {
    rate,
    gyd: (usd: number) =>
      `GYD ${Math.round(usd * rate).toLocaleString("en-US")}`,
    gydNumber: (usd: number) => Math.round(usd * rate),
  };
}
