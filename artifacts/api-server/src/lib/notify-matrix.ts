import { and, eq, inArray, isNull, or } from "drizzle-orm";
import {
  db,
  usersTable,
  dealerUsersTable,
  rolePermissionsTable,
  rolesTable,
  type PermissionModule,
} from "@workspace/db";

/**
 * R6.2 notification matrix — recipient resolution helpers.
 *
 * Every trigger in the matrix resolves its recipients through these queries
 * (never hard-coded user ids), then fans out via notifyUser (In-App primary),
 * enqueueEmail and enqueueWhatsapp with the trigger's canonical dedupeKey.
 */

/** Active users of a dealer whose role grants any of the given categories on a module. */
export async function usersWithPermission(
  dealerId: number,
  module: PermissionModule,
  // "view" is the master visibility switch — admin does NOT imply view, so
  // module-scoped notifications go only to roles with an explicit view grant.
  categories: string[] = ["view"],
): Promise<number[]> {
  const rows = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .innerJoin(dealerUsersTable, eq(dealerUsersTable.userId, usersTable.id))
    .innerJoin(
      rolePermissionsTable,
      eq(rolePermissionsTable.roleId, dealerUsersTable.roleId),
    )
    .where(
      and(
        eq(dealerUsersTable.dealerId, dealerId),
        eq(rolePermissionsTable.module, module),
        inArray(rolePermissionsTable.category, categories),
        eq(usersTable.status, "active"),
      ),
    );
  return [...new Set(rows.map((r) => r.id))];
}

/**
 * Active General Managers of a dealer.
 *
 * Older memberships may not have dealer_users.isGeneralManager populated, so
 * also recognize the canonical General Manager role. This prevents manager
 * notifications from silently having no recipients when the role is correct.
 */
export async function generalManagers(dealerId: number): Promise<number[]> {
  const rows = await db
    .select({ id: dealerUsersTable.userId })
    .from(dealerUsersTable)
    .innerJoin(usersTable, eq(usersTable.id, dealerUsersTable.userId))
    .leftJoin(rolesTable, eq(rolesTable.id, dealerUsersTable.roleId))
    .where(
      and(
        eq(dealerUsersTable.dealerId, dealerId),
        or(
          eq(dealerUsersTable.isGeneralManager, true),
          eq(rolesTable.name, "General Manager"),
        ),
        eq(usersTable.status, "active"),
      ),
    );
  return [...new Set(rows.map((r) => r.id))];
}

/**
 * Sales managers for a division: members with leads admin/approve rights in
 * that division (or division-less), falling back to the GMs when none match.
 */
export async function divisionSalesManagers(
  dealerId: number,
  divisionId: number | null,
): Promise<number[]> {
  const rows = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .innerJoin(dealerUsersTable, eq(dealerUsersTable.userId, usersTable.id))
    .innerJoin(
      rolePermissionsTable,
      eq(rolePermissionsTable.roleId, dealerUsersTable.roleId),
    )
    .where(
      and(
        eq(dealerUsersTable.dealerId, dealerId),
        eq(rolePermissionsTable.module, "leads"),
        inArray(rolePermissionsTable.category, ["admin", "approve"]),
        eq(usersTable.status, "active"),
        divisionId == null
          ? undefined
          : or(
              eq(dealerUsersTable.divisionId, divisionId),
              isNull(dealerUsersTable.divisionId),
            ),
      ),
    );
  const ids = [...new Set(rows.map((r) => r.id))];
  return ids.length > 0 ? ids : generalManagers(dealerId);
}

/**
 * The reporting manager of a dealer member (employee master), falling back to
 * the GMs when none is recorded.
 */
export async function reportingManagersOf(
  dealerId: number,
  userId: number,
): Promise<number[]> {
  const [row] = await db
    .select({ managerId: dealerUsersTable.reportingManagerUserId })
    .from(dealerUsersTable)
    .where(
      and(
        eq(dealerUsersTable.dealerId, dealerId),
        eq(dealerUsersTable.userId, userId),
      ),
    );
  if (row?.managerId) return [row.managerId];
  return generalManagers(dealerId);
}

/** Finance users of a dealer (module finance, view/admin). */
export function financeUsers(dealerId: number): Promise<number[]> {
  return usersWithPermission(dealerId, "finance");
}

/** Service users of a dealer (module service, view/admin). */
export function serviceUsers(dealerId: number): Promise<number[]> {
  return usersWithPermission(dealerId, "service");
}
