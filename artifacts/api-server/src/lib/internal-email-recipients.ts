import { and, eq } from "drizzle-orm";
import {
  db, dealerUsersTable, internalEmailRecipientsTable, rolePermissionsTable,
  usersTable, type EmailTemplate, type PermissionModule,
} from "@workspace/db";
import { usersWithPermission } from "./notify-matrix";

/** Only staff-directed automated templates. Customer, supplier and test messages
 * never participate in this routing policy, even when addressed to a staff email. */
export const INTERNAL_EMAIL_MODULES: Partial<Record<EmailTemplate, PermissionModule>> = {
  "lead.new": "leads",
  "lead.assigned": "leads",
  "test_drive_owner_invite": "leads",
  "lead.sla.breach.advisor": "leads",
  "lead.sla.breach.manager": "leads",
  "leads.source.report.daily": "leads",
  "document.missing.internal": "leads",
  "cancellation.manager": "deals",
  "refund.approved.finance": "finance",
  "delivery.ready": "deliveries",
  "delivered.service.handoff": "service",
  "case.opened": "service",
  "manager.note.advisor": "leads",
  "service.summary.management": "service",
  "collision.claim.action": "service",
  "parts.requisition.submitted": "parts",
  "parts.inventory.reorder": "parts",
};

export const INTERNAL_EMAIL_TEMPLATES = Object.keys(INTERNAL_EMAIL_MODULES) as EmailTemplate[];

/** Collapse one default fan-out event to one key per custom recipient. */
export function customInternalDedupeKey(key: string | undefined, userId: number) {
  return key ? `${key.replace(/:u\d+$/, "")}:internal:u${userId}` : undefined;
}

export function chooseInternalRecipients<T extends { id: number }>(
  eligible: T[], userIds: number[],
): T[] {
  return eligible.filter(user => userIds.includes(user.id));
}

/** Recheck pending/retried rows against CURRENT policy and staff visibility.
 * Resetting defaults discards previously custom-routed rows, not old defaults. */
export function internalDeliveryAllowed(
  customUserIds: number[] | null,
  eligible: { id: number; email: string }[],
  recipient: string,
  wasCustomRouted: boolean,
): boolean {
  if (customUserIds === null) return !wasCustomRouted;
  return chooseInternalRecipients(eligible, customUserIds).some(
    u => u.email.trim().toLowerCase() === recipient.trim().toLowerCase(),
  );
}

/** Explicit view is mandatory for NEW recipients; admin does not imply view. */
export async function eligibleInternalRecipients(dealerId: number, template: EmailTemplate, extraModule?: "finance" | "customers") {
  const module = INTERNAL_EMAIL_MODULES[template];
  if (!module) return [];
  const rows = await db.select({ id: usersTable.id, name: usersTable.name, email: usersTable.email })
    .from(usersTable)
    .innerJoin(dealerUsersTable, and(
      eq(dealerUsersTable.userId, usersTable.id),
      eq(dealerUsersTable.dealerId, dealerId),
    ))
    .innerJoin(rolePermissionsTable, and(
      eq(rolePermissionsTable.roleId, dealerUsersTable.roleId),
      eq(rolePermissionsTable.module, module),
      eq(rolePermissionsTable.category, "view"),
    ))
    .where(eq(usersTable.status, "active"));
  const extraIds = extraModule
    ? new Set(await usersWithPermission(dealerId, extraModule))
    : null;
  return rows.filter((r): r is typeof r & { email: string } =>
    Boolean(r.email?.trim()) && (!extraIds || extraIds.has(r.id)));
}

export async function internalRecipientPolicy(dealerId: number, template: EmailTemplate) {
  if (!INTERNAL_EMAIL_MODULES[template]) return null;
  const [row] = await db.select().from(internalEmailRecipientsTable).where(and(
    eq(internalEmailRecipientsTable.dealerId, dealerId),
    eq(internalEmailRecipientsTable.templateKey, template),
  ));
  return row ?? null;
}

export async function validateInternalRecipientSelection(
  dealerId: number, template: EmailTemplate, userIds: number[],
): Promise<boolean> {
  if (!INTERNAL_EMAIL_MODULES[template] || new Set(userIds).size !== userIds.length) return false;
  const eligible = await eligibleInternalRecipients(dealerId, template);
  return userIds.every(id => eligible.some(u => u.id === id));
}