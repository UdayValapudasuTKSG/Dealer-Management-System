import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable, auditLogsTable } from "@workspace/db";
import { GetCurrentUserResponse } from "@workspace/api-zod";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const LOGIN_AUDIT_GAP_MS = 6 * 60 * 60 * 1000; // treat >6h since last login as a fresh login

router.get("/auth/me", async (_req, res): Promise<void> => {
  const user = res.locals.user;
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const now = new Date();
  if (
    !user.lastLoginAt ||
    now.getTime() - new Date(user.lastLoginAt).getTime() > LOGIN_AUDIT_GAP_MS
  ) {
    await db
      .update(usersTable)
      .set({ lastLoginAt: now, updatedAt: now })
      .where(eq(usersTable.id, user.id));
    db.insert(auditLogsTable)
      .values({
        actorUserId: user.id,
        actorClerkId: user.clerkId,
        actorName: user.name,
        actorEmail: user.email,
        action: "login",
        module: "settings",
        entityType: "session",
        summary: `${user.name ?? user.email ?? user.clerkId} signed in`,
      })
      .catch((err) => logger.error({ err }, "Failed to write login audit"));
  }

  res.json(
    GetCurrentUserResponse.parse({
      id: user.id,
      clerkId: user.clerkId,
      email: user.email,
      name: user.name,
      imageUrl: user.imageUrl,
      roleId: user.roleId,
      roleName: user.roleName,
      status: user.status,
      isSuperAdmin: user.isSuperAdmin,
      activeDealerId: user.dealerId,
      entitlements:
        user.dealers.find((d) => d.dealerId === user.dealerId)?.entitlements ??
        {},
      dealers: user.dealers,
      permissions: user.permissions,
    }),
  );
});

router.post("/auth/logout-event", async (_req, res): Promise<void> => {
  const user = res.locals.user;
  if (user) {
    db.insert(auditLogsTable)
      .values({
        actorUserId: user.id,
        actorClerkId: user.clerkId,
        actorName: user.name,
        actorEmail: user.email,
        action: "logout",
        module: "settings",
        entityType: "session",
        summary: `${user.name ?? user.email ?? user.clerkId} signed out`,
      })
      .catch((err) => logger.error({ err }, "Failed to write logout audit"));
  }
  res.status(204).end();
});

export default router;
