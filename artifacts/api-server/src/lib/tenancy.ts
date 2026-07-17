import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  dealersTable,
  dealerUsersTable,
  usersTable,
  rolesTable,
} from "@workspace/db";

// ---------------------------------------------------------------------------
// Multi-dealer tenancy helpers.
// ---------------------------------------------------------------------------

let cached: number | null = null;

/**
 * Default dealer for background intake (Meta / WhatsApp / Gmail webhooks that
 * carry no active dealer context). Resolves to CAM Motors, falling back to id 2.
 */
export async function defaultDealerId(): Promise<number> {
  if (cached != null) return cached;
  const [d] = await db
    .select({ id: dealersTable.id })
    .from(dealersTable)
    .where(eq(dealersTable.name, "CAM Motors"));
  cached = d?.id ?? 2;
  return cached;
}

/**
 * Active staff user ids belonging to a dealer whose dealer-role matches one of
 * the given role names. Replaces the retired global users.roleId lookup.
 */
export async function dealerStaffIdsByRole(
  dealerId: number,
  roleNames: string[],
): Promise<number[]> {
  if (roleNames.length === 0) return [];
  const rows = await db
    .select({ id: usersTable.id })
    .from(dealerUsersTable)
    .innerJoin(usersTable, eq(dealerUsersTable.userId, usersTable.id))
    .innerJoin(rolesTable, eq(dealerUsersTable.roleId, rolesTable.id))
    .where(
      and(
        eq(dealerUsersTable.dealerId, dealerId),
        eq(usersTable.status, "active"),
        inArray(rolesTable.name, roleNames),
      ),
    );
  return rows.map((r) => r.id);
}
