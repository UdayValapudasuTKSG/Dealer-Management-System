import { eq } from "drizzle-orm";
import {
  db,
  roleFieldPermissionsTable,
  FIELD_GROUPS,
  type FieldAccessLevel,
} from "@workspace/db";
import type { AuthedUser } from "../middlewares/rbac";
import { blockedEditFieldFromGrants } from "./field-permission-policy";

export { blockedEditFieldFromGrants } from "./field-permission-policy";

/**
 * Field-level access control. Role field grants are cached briefly (same
 * spirit as the RBAC permission cache). Roles with no grant for a group
 * default to full "edit" access, so behavior is unchanged until an admin
 * restricts something.
 */
const TTL_MS = 30_000;
const cache = new Map<
  number,
  { ts: number; access: Map<string, FieldAccessLevel> }
>();

export function invalidateFieldPermCache(roleId?: number) {
  if (roleId !== undefined) cache.delete(roleId);
  else cache.clear();
}

async function loadAccess(roleId: number): Promise<Map<string, FieldAccessLevel>> {
  const hit = cache.get(roleId);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.access;
  const rows = await db
    .select()
    .from(roleFieldPermissionsTable)
    .where(eq(roleFieldPermissionsTable.roleId, roleId));
  const access = new Map<string, FieldAccessLevel>(
    rows.map((r) => [r.fieldGroup, r.access as FieldAccessLevel]),
  );
  cache.set(roleId, { ts: Date.now(), access });
  return access;
}

function activeRoleId(user: AuthedUser | undefined): number | null {
  if (!user || user.isSuperAdmin) return null;
  const membership = user.dealers.find((d) => d.dealerId === user.dealerId);
  return membership?.roleId ?? null;
}

export type ModuleKey = "leads" | "inventory" | "deals";

/** Per-group access for the request user, restricted to one module. */
export async function fieldAccessFor(
  user: AuthedUser | undefined,
  module: ModuleKey,
): Promise<{ group: (typeof FIELD_GROUPS)[number]; access: FieldAccessLevel }[]> {
  const roleId = activeRoleId(user);
  const groups = FIELD_GROUPS.filter((g) => g.module === module);
  if (roleId == null) {
    return groups.map((group) => ({ group, access: "edit" as const }));
  }
  const access = await loadAccess(roleId);
  return groups.map((group) => ({
    group,
    access: access.get(group.key) ?? ("edit" as const),
  }));
}

/**
 * Returns the first restricted field present in `body`, or null if the user
 * may edit everything they sent. Call in PATCH/POST handlers before writing.
 */
export async function findBlockedEditField(
  user: AuthedUser | undefined,
  module: ModuleKey,
  body: Record<string, unknown>,
): Promise<{ field: string; groupLabel: string } | null> {
  const grants = await fieldAccessFor(user, module);
  return blockedEditFieldFromGrants(grants, body);
}

/**
 * Redacts (nulls) fields belonging to "hidden" groups on an outgoing row.
 * Only nullable response fields (`group.redactable`) are touched so response
 * contracts stay valid; non-nullable fields fall back to view-only.
 */
export async function redactHiddenFields<T extends Record<string, unknown>>(
  user: AuthedUser | undefined,
  module: ModuleKey,
  rows: T[],
): Promise<T[]> {
  const grants = await fieldAccessFor(user, module);
  const hidden = grants.filter((g) => g.access === "hidden");
  if (hidden.length === 0) return rows;
  return rows.map((row) => {
    const copy: Record<string, unknown> = { ...row };
    for (const { group } of hidden) {
      for (const field of group.redactable) {
        if (field in copy) copy[field] = null;
      }
    }
    return copy as T;
  });
}
