import { and, eq } from "drizzle-orm";
import { db, dealerUsersTable } from "@workspace/db";
import type { AuthedUser } from "../middlewares/rbac";
import {
  formatDealerDate,
  zonedAddDays,
  zonedParts,
  zonedStartOfDay,
  zonedTimeToUtc,
} from "./timezone";

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
/* Dealer-local time + GYD money helpers (server-side serialization)  */
/* ------------------------------------------------------------------ */

export function dealerMonthKey(d: Date | string, tz: string): string {
  const p = zonedParts(new Date(d), tz);
  return `${p.year}-${p.month - 1}`;
}

export function dealerDateLabel(
  d: Date | string | null | undefined,
  tz: string,
): string {
  if (!d) return "—";
  const formatted = formatDealerDate(d, tz);
  const match = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/.exec(formatted);
  return match ? `${match[2]!.padStart(2, "0")} ${match[1]} ${match[3]}` : formatted;
}

/** Parse a YYYY-MM-DD range as dealer-local day boundaries. */
export function parseDealerRange(tz: string, fromRaw?: string, toRaw?: string) {
  const to = toRaw
    ? new Date(zonedStartOfDay(zonedAddDays(zonedStartOfDay(toRaw, tz), tz, 1), tz).getTime() - 1)
    : new Date();
  let from: Date;
  if (fromRaw) {
    from = zonedStartOfDay(fromRaw, tz);
  } else {
    const p = zonedParts(to, tz);
    const shifted = new Date(Date.UTC(p.year, p.month - 1 - 6, 1, 12));
    from = zonedTimeToUtc(
      tz,
      shifted.getUTCFullYear(),
      shifted.getUTCMonth() + 1,
      p.day,
      p.hour,
      p.minute,
      p.second,
    );
  }
  return { from, to };
}

/** GYD money formatter — amounts are stored in GYD. */
export function makeGyd(_usdExchangeRate?: number | null | undefined) {
  return {
    /** exchange rates removed — amounts are stored in GYD */
    rate: 1,
    gyd: (n: number) => `GYD ${Math.round(n).toLocaleString("en-US")}`,
    gydNumber: (n: number) => Math.round(n),
  };
}
