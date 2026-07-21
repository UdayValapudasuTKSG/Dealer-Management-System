import { and, eq, sql } from "drizzle-orm";
import { db, usersTable, dealerUsersTable } from "@workspace/db";

/**
 * Best-effort resolution of a dealer staff member's user ID from their
 * display name (case-insensitive). Returns null when no unique match is
 * found. Used to stamp user IDs on records that historically only stored
 * display names, so persona scoping can match by ID instead of name.
 */
export async function resolveDealerUserIdByName(
  dealerId: number,
  name: string | null | undefined,
): Promise<number | null> {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  const rows = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .innerJoin(dealerUsersTable, eq(dealerUsersTable.userId, usersTable.id))
    .where(
      and(
        eq(dealerUsersTable.dealerId, dealerId),
        sql`lower(${usersTable.name}) = lower(${trimmed})`,
      ),
    )
    .limit(2);
  // Ambiguous names (two staff with the same name) resolve to nothing —
  // that ambiguity is exactly why records should carry an explicit ID.
  return rows.length === 1 ? rows[0]!.id : null;
}
