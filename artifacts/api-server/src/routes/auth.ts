import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable, auditLogsTable } from "@workspace/db";
import {
  GetCurrentUserResponse,
  UpdateMyProfileBody,
  UpdateMyProfileResponse,
} from "@workspace/api-zod";
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
      phone: user.phone,
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

router.patch("/auth/me", async (req, res): Promise<void> => {
  const user = res.locals.user;
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  // NC-10: impersonation sessions must never rewrite the impersonated
  // user's own profile (the generic impersonation write-block exempts the
  // auth segment, so guard explicitly here).
  if (res.locals.impersonation) {
    res.status(403).json({
      error: "Profile changes are not permitted while impersonating",
      code: "impersonation_blocked",
    });
    return;
  }
  const parsed = UpdateMyProfileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ error: "Invalid input", details: parsed.error.issues });
    return;
  }
  const patch: { name?: string; phone?: string | null } = {};
  if (parsed.data.name !== undefined) {
    const name = parsed.data.name.trim();
    if (!name) {
      res.status(422).json({ error: "Name cannot be blank" });
      return;
    }
    patch.name = name;
  }
  if (parsed.data.phone !== undefined) {
    const phone = parsed.data.phone?.trim() ?? null;
    patch.phone = phone === "" ? null : phone;
  }
  if (Object.keys(patch).length === 0) {
    res.json(
      UpdateMyProfileResponse.parse({
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        imageUrl: user.imageUrl,
      }),
    );
    return;
  }
  const [updated] = await db
    .update(usersTable)
    .set({ ...patch, updatedAt: new Date(), updatedBy: user.clerkId })
    .where(eq(usersTable.id, user.id))
    .returning();
  db.insert(auditLogsTable)
    .values({
      actorUserId: user.id,
      actorClerkId: user.clerkId,
      actorName: updated!.name,
      actorEmail: user.email,
      action: "update",
      module: "settings",
      entityType: "user_profile",
      entityId: String(user.id),
      summary: `${updated!.name ?? user.email ?? user.clerkId} updated their profile`,
    })
    .catch((err) => logger.error({ err }, "Failed to write profile audit"));
  res.json(
    UpdateMyProfileResponse.parse({
      id: updated!.id,
      name: updated!.name,
      email: updated!.email,
      phone: updated!.phone,
      imageUrl: updated!.imageUrl,
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
