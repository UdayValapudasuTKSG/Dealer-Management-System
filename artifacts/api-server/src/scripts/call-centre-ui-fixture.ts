/** Optional fixture for browser tests. Caller MUST await fixture.cleanup() in finally. */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

export async function createCallCentreUiFixture(options: { managerUserId?: number; followUp?: boolean } = {}) {
  if (process.env.NODE_ENV !== "development" || process.env.TEST_CALL_CENTRE_DB !== "yes" || process.env.EXTERNAL_DATABASE_URL) {
    throw new Error("Call-centre UI fixtures require explicit development test opt-in");
  }
  const url = new URL(process.env.DATABASE_URL ?? process.env.DEV_DATABASE_URL ?? "");
  if (!["helium", "localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Not an allowlisted development database");
  const {
    db, dealersTable, usersTable, rolesTable, rolePermissionsTable, dealerUsersTable,
    leadsTable, tasksTable, callLogsTable, timelineEventsTable, notificationsTable, emailLogsTable,
  } = await import("@workspace/db");
  const { zonedDayKey } = await import("../lib/timezone");
  const token = randomUUID();
  const followUpDate = options.followUp
    ? zonedDayKey(new Date(Date.now() + 3 * 86400000), "America/Guyana") : null;
  const fixture = await db.transaction(async (tx) => {
    const [dealer] = await tx.insert(dealersTable).values({ name: `CC browser fixture ${token}`, timezone: "America/Guyana" }).returning();
    // Deliberately whitespace-distinct temporary role, NOT the production role.
    const [role] = await tx.insert(rolesTable).values({ name: `Call${" ".repeat(32)}Center Representative` }).returning();
    for (const category of ["view", "edit"]) {
      await tx.insert(rolePermissionsTable).values({ roleId: role!.id, module: "leads", category });
    }
    if (options.managerUserId != null) {
      const [manager] = await tx.select().from(usersTable).where(and(
        eq(usersTable.id, options.managerUserId), eq(usersTable.status, "active"),
      ));
      const [managerRole] = await tx.select().from(rolesTable).where(eq(rolesTable.name, "General Manager"));
      const [assignGrant] = managerRole ? await tx.select().from(rolePermissionsTable).where(and(
        eq(rolePermissionsTable.roleId, managerRole.id),
        eq(rolePermissionsTable.module, "leads"), eq(rolePermissionsTable.category, "assign"),
      )) : [];
      if (!manager || !managerRole || !assignGrant) {
        throw new Error("Fixture requires an active manager user and a General Manager role with leads:assign");
      }
      await tx.insert(dealerUsersTable).values({
        dealerId: dealer!.id, userId: manager.id, roleId: managerRole.id,
      });
    }
    const [user] = await tx.insert(usersTable).values({ clerkId: `cc-browser-${token}`, name: "Temporary call-centre tester" }).returning();
    await tx.insert(dealerUsersTable).values({ dealerId: dealer!.id, userId: user!.id, roleId: role!.id });
    const [secondRep] = await tx.insert(usersTable).values({
      clerkId: `cc-browser-${token}-second`, name: "Temporary call-centre replacement",
    }).returning();
    await tx.insert(dealerUsersTable).values({ dealerId: dealer!.id, userId: secondRep!.id, roleId: role!.id });
    const [lead] = await tx.insert(leadsTable).values({
      dealerId: dealer!.id, name: "Temporary qualification fixture", source: "website",
      ownerUserId: user!.id, assignedTo: user!.name, callCentreStatus: followUpDate ? "follow_up" : "pending",
      callCentreRepId: user!.id, callCentreAssignedAt: new Date(),
      callCentreFollowUpDate: followUpDate,
    }).returning();
    if (followUpDate) {
      await tx.insert(tasksTable).values({
        dealerId: dealer!.id, leadId: lead!.id, title: `Call centre follow-up: ${lead!.name}`,
        assigneeUserId: user!.id, dueDate: followUpDate,
        kind: "call_centre", priority: "normal", status: "open",
      });
    }
    return { dealerId: dealer!.id, userId: user!.id, secondRepId: secondRep!.id,
      roleId: role!.id, leadId: lead!.id, followUpDate };
  });
  return {
    ...fixture,
    async cleanup() {
      await db.transaction(async (tx) => {
        // Only fixture-owned rows; no mutation of existing memberships or roles.
        for (const table of [tasksTable, callLogsTable, timelineEventsTable, notificationsTable, emailLogsTable, leadsTable, dealerUsersTable]) {
          await tx.delete(table).where(eq(table.dealerId, fixture.dealerId));
        }
        await tx.delete(dealersTable).where(eq(dealersTable.id, fixture.dealerId));
        await tx.delete(usersTable).where(eq(usersTable.id, fixture.userId));
        await tx.delete(usersTable).where(eq(usersTable.id, fixture.secondRepId));
        await tx.delete(rolePermissionsTable).where(eq(rolePermissionsTable.roleId, fixture.roleId));
        await tx.delete(rolesTable).where(eq(rolesTable.id, fixture.roleId));
      });
    },
  };
}