import { Router, type IRouter } from "express";
import { eq, desc, and, notInArray, gt, count } from "drizzle-orm";
import { db, leadsTable, usersTable, rolesTable } from "@workspace/db";
import {
  GetTeamMemberParams,
  GetTeamMemberResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

const CLOSED_STATUSES = ["converted", "lost"];

// Lightweight staff profile for the lead-owner link on record pages.
// Auth-only (no module permission): any signed-in user may view a colleague.
router.get("/team/:id", async (req, res): Promise<void> => {
  const params = GetTeamMemberParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [row] = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
      imageUrl: usersTable.imageUrl,
      status: usersTable.status,
      createdAt: usersTable.createdAt,
      lastLoginAt: usersTable.lastLoginAt,
      roleName: rolesTable.name,
    })
    .from(usersTable)
    .leftJoin(rolesTable, eq(usersTable.roleId, rolesTable.id))
    .where(eq(usersTable.id, params.data.id));

  if (!row) {
    res.status(404).json({ error: "Team member not found" });
    return;
  }

  const [[open], [total], [won], [drives], recent] = await Promise.all([
    db
      .select({ n: count() })
      .from(leadsTable)
      .where(
        and(
          eq(leadsTable.ownerUserId, row.id),
          notInArray(leadsTable.status, CLOSED_STATUSES),
        ),
      ),
    db
      .select({ n: count() })
      .from(leadsTable)
      .where(eq(leadsTable.ownerUserId, row.id)),
    db
      .select({ n: count() })
      .from(leadsTable)
      .where(
        and(
          eq(leadsTable.ownerUserId, row.id),
          eq(leadsTable.status, "converted"),
        ),
      ),
    db
      .select({ n: count() })
      .from(leadsTable)
      .where(
        and(
          eq(leadsTable.ownerUserId, row.id),
          gt(leadsTable.testDriveAt, new Date()),
        ),
      ),
    db
      .select({
        id: leadsTable.id,
        name: leadsTable.name,
        status: leadsTable.status,
        phase: leadsTable.phase,
        createdAt: leadsTable.createdAt,
      })
      .from(leadsTable)
      .where(eq(leadsTable.ownerUserId, row.id))
      .orderBy(desc(leadsTable.createdAt))
      .limit(8),
  ]);

  res.json(
    GetTeamMemberResponse.parse({
      id: row.id,
      name: row.name ?? row.email ?? `User ${row.id}`,
      email: row.email,
      imageUrl: row.imageUrl,
      roleName: row.roleName,
      status: row.status,
      memberSince: row.createdAt,
      lastLoginAt: row.lastLoginAt,
      openLeads: open?.n ?? 0,
      totalLeads: total?.n ?? 0,
      wonLeads: won?.n ?? 0,
      upcomingTestDrives: drives?.n ?? 0,
      recentLeads: recent,
    }),
  );
});

export default router;
