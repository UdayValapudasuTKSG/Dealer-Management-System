import { eq, sql, and, notInArray, inArray, isNotNull } from "drizzle-orm";
import {
  db,
  leadsTable,
  usersTable,
  rolesTable,
  dealerUsersTable,
  agentsTable,
  activityTable,
  timelineEventsTable,
  vehiclesTable,
  type Lead,
} from "@workspace/db";
import { enqueueEmail, notifyUser } from "./email";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Sales agent — automatic lead routing.
//
// When a new lead lands without an owner, the Sales agent assigns it to the
// least-loaded active Sales Advisor (fallback: Sales Manager) so no lead sits
// unowned. Mirrors the manual POST /leads/:id/assign side-effects: status
// new→assigned, phase aware→consider, timeline event, advisor notification,
// lead_assignment email — plus an agent activity entry for the dashboard feed.
// Never throws: on any failure the lead simply stays unassigned for a human.
// ---------------------------------------------------------------------------

const AGENT_KEY = "sales";
const AGENT_ACTOR = "AURA Sales Agent";

type Candidate = {
  id: number;
  name: string | null;
  email: string | null;
  roleName: string | null;
};

async function candidateAdvisors(dealerId: number): Promise<Candidate[]> {
  const rows = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
      roleName: rolesTable.name,
    })
    .from(dealerUsersTable)
    .innerJoin(usersTable, eq(dealerUsersTable.userId, usersTable.id))
    .innerJoin(rolesTable, eq(dealerUsersTable.roleId, rolesTable.id))
    .where(
      and(
        eq(dealerUsersTable.dealerId, dealerId),
        eq(usersTable.status, "active"),
        inArray(rolesTable.name, ["Sales Advisor", "Sales Manager"]),
      ),
    );
  const advisors = rows.filter((r) => r.roleName === "Sales Advisor");
  return advisors.length > 0 ? advisors : rows;
}

/** Open-lead count per owner (won/lost excluded) for workload balancing. */
async function openLeadCounts(
  dealerId: number,
  userIds: number[],
): Promise<Map<number, number>> {
  const counts = new Map<number, number>(userIds.map((id) => [id, 0]));
  if (userIds.length === 0) return counts;
  const rows = await db
    .select({
      ownerUserId: leadsTable.ownerUserId,
      count: sql<number>`count(*)::int`,
    })
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.dealerId, dealerId),
        isNotNull(leadsTable.ownerUserId),
        inArray(leadsTable.ownerUserId, userIds),
        notInArray(leadsTable.phase, ["won", "lost"]),
      ),
    )
    .groupBy(leadsTable.ownerUserId);
  for (const row of rows) {
    if (row.ownerUserId != null) counts.set(row.ownerUserId, row.count);
  }
  return counts;
}

async function vehicleLabelFor(lead: Lead): Promise<string> {
  if (!lead.interestedVehicleId) return "";
  const [v] = await db
    .select({
      year: vehiclesTable.year,
      make: vehiclesTable.make,
      model: vehiclesTable.model,
    })
    .from(vehiclesTable)
    .where(eq(vehiclesTable.id, lead.interestedVehicleId));
  return v ? `${v.year} ${v.make} ${v.model}` : "";
}

/**
 * Auto-assign an unowned lead to the least-loaded advisor. Returns the
 * updated lead, or null when no assignment happened (already owned, no
 * eligible advisors, or an internal failure).
 */
export async function autoAssignLead(lead: Lead): Promise<Lead | null> {
  if (lead.ownerUserId != null) return null;
  try {
    const candidates = await candidateAdvisors(lead.dealerId);
    if (candidates.length === 0) {
      logger.warn(
        { leadId: lead.id },
        "Sales agent: no active advisors to auto-assign lead",
      );
      return null;
    }

    const counts = await openLeadCounts(
      lead.dealerId,
      candidates.map((c) => c.id),
    );
    const ranked = [...candidates].sort((a, b) => {
      const load = (counts.get(a.id) ?? 0) - (counts.get(b.id) ?? 0);
      return load !== 0 ? load : a.id - b.id;
    });
    const advisor = ranked[0]!;
    const advisorName = advisor.name ?? advisor.email ?? `User #${advisor.id}`;
    const load = counts.get(advisor.id) ?? 0;

    const [updated] = await db
      .update(leadsTable)
      .set({
        ownerUserId: advisor.id,
        assignedTo: advisorName,
        status:
          lead.status === "new" || lead.status === "assigned"
            ? "assigned"
            : lead.status,
        phase: lead.phase === "aware" ? "consider" : lead.phase,
      })
      .where(and(eq(leadsTable.id, lead.id), sql`owner_user_id is null`))
      .returning();
    if (!updated) return null; // raced with a manual assignment

    const reasoning = `Routed by workload balance — ${advisorName} has ${load} active lead${load === 1 ? "" : "s"} (lowest on the team).`;

    await db.insert(timelineEventsTable).values({
      dealerId: updated.dealerId,
      customerId: updated.customerId,
      domain: "leads",
      kind: "advisor_assigned",
      title: `Assigned to ${advisorName}`,
      detail: reasoning,
      actor: AGENT_ACTOR,
      isAgent: true,
      refType: "lead",
      refId: updated.id,
    });

    await db.insert(activityTable).values({
      dealerId: updated.dealerId,
      agentKey: AGENT_KEY,
      actor: AGENT_ACTOR,
      isAi: true,
      action: "Auto-assigned new lead",
      entity: updated.name,
      detail: reasoning,
    });
    await db
      .update(agentsTable)
      .set({ tasksToday: sql`${agentsTable.tasksToday} + 1` })
      .where(
        and(
          eq(agentsTable.key, AGENT_KEY),
          eq(agentsTable.dealerId, updated.dealerId),
        ),
      );

    await notifyUser({
      userId: advisor.id,
      dealerId: updated.dealerId,
      type: "assignment",
      title: `Lead assigned: ${updated.name}`,
      body: "AURA routed this lead to you — make first contact and update the status.",
      link: `/lead/${updated.id}`,
    });

    if (updated.email) {
      await enqueueEmail({
        template: "lead_assignment",
        to: updated.email,
        dealerId: updated.dealerId,
        customerId: updated.customerId,
        data: {
          advisor: advisorName,
          vehicle: await vehicleLabelFor(updated),
        },
      });
    }

    return updated;
  } catch (err) {
    logger.error({ err, leadId: lead.id }, "Sales agent auto-assign failed");
    return null;
  }
}
