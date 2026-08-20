import { and, eq, inArray, ne, sql } from "drizzle-orm";
import {
  callLogsTable,
  db,
  leadsTable,
  type CallLog,
  type Lead,
} from "@workspace/db";

/**
 * The existing stage gate treats every finished call disposition as logged
 * outreach. Keep SLA completion aligned with that rule; only an in-progress
 * browser call is too early to count.
 */
export function callCountsAsFirstContact(status: string): boolean {
  return status !== "in_progress";
}

/**
 * Persist the first finished call onto the lead's denormalized contact fields.
 * The call log remains the source of truth; this stamp keeps list/detail views
 * and downstream analytics fast and consistent for newly logged calls.
 */
export async function markLeadContactFromCall(
  call: CallLog,
): Promise<Lead | null> {
  if (!callCountsAsFirstContact(call.status)) return null;

  const contactAt = call.createdAt;
  const [lead] = await db
    .update(leadsTable)
    .set({
      contactedDate: sql<Date>`coalesce(${leadsTable.contactedDate}, ${contactAt})`,
      status: sql<string>`case
        when ${leadsTable.status} in ('new', 'assigned') then 'contacted'
        else ${leadsTable.status}
      end`,
      phase: sql<string>`case
        when ${leadsTable.phase} = 'new' then 'contacted'
        else ${leadsTable.phase}
      end`,
      stageEnteredAt: sql<Date | null>`case
        when ${leadsTable.phase} = 'new' then ${contactAt}
        else ${leadsTable.stageEnteredAt}
      end`,
    })
    .where(
      and(
        eq(leadsTable.id, call.leadId),
        eq(leadsTable.dealerId, call.dealerId),
      ),
    )
    .returning();

  return lead ?? null;
}

/**
 * Overlay the earliest finished call onto leads whose denormalized
 * contactedDate predates this fix. This makes historical call logs stop the
 * SLA immediately without requiring a risky write-on-read backfill.
 */
export async function withEffectiveContactDates<
  T extends { id: number; contactedDate: Date | null },
>(dealerId: number, leads: T[]): Promise<T[]> {
  const missingIds = leads
    .filter((lead) => lead.contactedDate == null)
    .map((lead) => lead.id);
  if (missingIds.length === 0) return leads;

  const rows = await db
    .select({
      leadId: callLogsTable.leadId,
      contactedAt: sql<string>`min(${callLogsTable.createdAt})`,
    })
    .from(callLogsTable)
    .where(
      and(
        eq(callLogsTable.dealerId, dealerId),
        inArray(callLogsTable.leadId, missingIds),
        ne(callLogsTable.status, "in_progress"),
      ),
    )
    .groupBy(callLogsTable.leadId);

  const contactedAtByLead = new Map(
    rows.map(
      (row) => [row.leadId, new Date(row.contactedAt)] as const,
    ),
  );
  return leads.map((lead) => {
    const contactedAt = contactedAtByLead.get(lead.id);
    return contactedAt ? { ...lead, contactedDate: contactedAt } : lead;
  });
}