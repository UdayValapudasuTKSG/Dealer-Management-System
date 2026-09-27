/** Optional fixture for browser tests. Caller MUST await fixture.cleanup() in finally. */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

export async function createCallCentreUiFixture() {
  if (process.env.NODE_ENV !== "development" || process.env.TEST_CALL_CENTRE_DB !== "yes" || process.env.EXTERNAL_DATABASE_URL) {
    throw new Error("Call-centre UI fixtures require explicit development test opt-in");
  }
  const url = new URL(process.env.DATABASE_URL ?? process.env.DEV_DATABASE_URL ?? "");
  if (!["helium", "localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Not an allowlisted development database");
  const {
    db, dealersTable, usersTable, rolesTable, rolePermissionsTable, dealerUsersTable,
    leadsTable, tasksTable, callLogsTable, timelineEventsTable, notificationsTable, emailLogsTable,
  } = await import("@workspace/db");
  const token = randomUUID();
  const fixture = await db.transaction(async (tx) => {
    const [dealer] = await tx.insert(dealersTable).values({ name: `CC browser fixture ${token}`, timezone: "America/Guyana" }).returning();
    // Deliberately whitespace-distinct temporary role, NOT the production role.
    const [role] = await tx.insert(rolesTable).values({ name: `Call${" ".repeat(32)}Center Representative` }).returning();
    for (const category of ["view", "edit"]) {
      await tx.insert(rolePermissionsTable).values({ roleId: role!.id, module: "leads", category });
    }
    const [user] = await tx.insert(usersTable).values({ clerkId: `cc-browser-${token}`, name: "Temporary call-centre tester" }).returning();
    await tx.insert(dealerUsersTable).values({ dealerId: dealer!.id, userId: user!.id, roleId: role!.id });
    const [lead] = await tx.insert(leadsTable).values({
      dealerId: dealer!.id, name: "Temporary qualification fixture", source: "website",
      ownerUserId: user!.id, assignedTo: user!.name, callCentreStatus: "pending",
      callCentreRepId: user!.id, callCentreAssignedAt: new Date(),
    }).returning();
    return { dealerId: dealer!.id, userId: user!.id, roleId: role!.id, leadId: lead!.id };
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
        await tx.delete(rolePermissionsTable).where(eq(rolePermissionsTable.roleId, fixture.roleId));
        await tx.delete(rolesTable).where(eq(rolesTable.id, fixture.roleId));
      });
    },
  };
}