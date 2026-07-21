import { Router, type IRouter, type Response } from "express";
import { asc, desc, eq, sql, and, isNull } from "drizzle-orm";
import {
  db,
  dealersTable,
  dealerUsersTable,
  usersTable,
  rolesTable,
  agentsTable,
  auditLogsTable,
  impersonationGrantsTable,
  type AuditAction,
} from "@workspace/db";
import {
  ListDealersResponse,
  CreateDealerBody,
  CreateDealerResponse,
  UpdateDealerParams,
  UpdateDealerBody,
  UpdateDealerResponse,
  ListDealerMembersParams,
  ListDealerMembersResponse,
  AddDealerMemberParams,
  AddDealerMemberBody,
  AddDealerMemberResponse,
  UpdateDealerMemberParams,
  UpdateDealerMemberBody,
  UpdateDealerMemberResponse,
  RemoveDealerMemberParams,
  ListPlatformUsersResponse,
  ListDealerAgentsParams,
  ListDealerAgentsResponse,
  UpdateDealerAgentParams,
  UpdateDealerAgentBody,
  UpdateDealerAgentResponse,
  ListPlatformAuditQueryParams,
  ListPlatformAuditResponse,
  StartImpersonationBody,
  StartImpersonationResponse,
} from "@workspace/api-zod";
import { createDealerProvisioned, pauseDealerAgents } from "../lib/provisioning";
import { invalidateGrantCache } from "../middlewares/rbac";
import { logger } from "../lib/logger";

// All /platform routes are gated to the super admin in middlewares/rbac.ts
// (authorize short-circuits the "platform" segment on user.isSuperAdmin).
const router: IRouter = Router();

/** How long a super-admin impersonation grant stays valid. */
export const IMPERSONATION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

/** Platform-level audit rows carry dealerId = null so they never leak into a
 * dealer's own audit trail; the subject dealer goes in details. */
async function platformAudit(
  res: Response,
  entry: {
    action: AuditAction;
    entityType: string;
    entityId: string | number | null;
    summary: string;
    details?: Record<string, unknown>;
  },
) {
  const user = res.locals.user;
  try {
    await db.insert(auditLogsTable).values({
      dealerId: null,
      actorUserId: user?.id ?? null,
      actorClerkId: user?.clerkId ?? null,
      actorName: user?.name ?? null,
      actorEmail: user?.email ?? null,
      action: entry.action,
      module: "platform",
      entityType: entry.entityType,
      entityId: entry.entityId == null ? null : String(entry.entityId),
      summary: entry.summary,
      details: entry.details ?? null,
    });
  } catch (err) {
    logger.error({ err }, "Failed to write platform audit row");
  }
}

async function dealerWithCount(id: number) {
  const [dealer] = await db
    .select()
    .from(dealersTable)
    .where(eq(dealersTable.id, id));
  if (!dealer) return null;
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(dealerUsersTable)
    .where(eq(dealerUsersTable.dealerId, id));
  return { ...dealer, userCount: count };
}

router.get("/platform/dealers", async (_req, res): Promise<void> => {
  const dealers = await db
    .select()
    .from(dealersTable)
    .orderBy(asc(dealersTable.id));
  const counts = await db
    .select({
      dealerId: dealerUsersTable.dealerId,
      count: sql<number>`count(*)::int`,
    })
    .from(dealerUsersTable)
    .groupBy(dealerUsersTable.dealerId);
  const countMap = new Map(counts.map((c) => [c.dealerId, c.count]));
  res.json(
    ListDealersResponse.parse(
      dealers.map((d) => ({ ...d, userCount: countMap.get(d.id) ?? 0 })),
    ),
  );
});

router.post("/platform/dealers", async (req, res): Promise<void> => {
  const body = CreateDealerBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const name = body.data.name.trim();
  const [existing] = await db
    .select({ id: dealersTable.id })
    .from(dealersTable)
    .where(sql`lower(${dealersTable.name}) = ${name.toLowerCase()}`);
  if (existing) {
    res.status(409).json({ error: "A dealer with this name already exists" });
    return;
  }
  const created = await createDealerProvisioned({
    name,
    city: body.data.city ?? null,
    country: body.data.country ?? null,
    status: body.data.status ?? "active",
    ...(body.data.usdExchangeRate !== undefined
      ? { usdExchangeRate: body.data.usdExchangeRate }
      : {}),
    ...(body.data.entitlements !== undefined
      ? { entitlements: body.data.entitlements }
      : {}),
    createdBy: res.locals.user?.clerkId ?? null,
  });
  await platformAudit(res, {
    action: "provision",
    entityType: "dealer",
    entityId: created.id,
    summary: `${res.locals.user?.name ?? "Super admin"} onboarded dealership "${created.name}" (divisions, roles, stage checklists, agents provisioned)`,
    details: { dealerId: created.id },
  });
  res
    .status(201)
    .json(CreateDealerResponse.parse({ ...created, userCount: 0 }));
});

router.patch("/platform/dealers/:id", async (req, res): Promise<void> => {
  const params = UpdateDealerParams.safeParse(req.params);
  const body = UpdateDealerBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const [before] = await db
    .select({ status: dealersTable.status })
    .from(dealersTable)
    .where(eq(dealersTable.id, params.data.id));
  if (!before) {
    res.status(404).json({ error: "Dealer not found" });
    return;
  }
  const [updated] = await db
    .update(dealersTable)
    .set({
      name: body.data.name.trim(),
      ...(body.data.city !== undefined ? { city: body.data.city } : {}),
      ...(body.data.country !== undefined
        ? { country: body.data.country }
        : {}),
      ...(body.data.status !== undefined ? { status: body.data.status } : {}),
      ...(body.data.usdExchangeRate !== undefined
        ? { usdExchangeRate: body.data.usdExchangeRate }
        : {}),
      ...(body.data.entitlements !== undefined
        ? { entitlements: body.data.entitlements }
        : {}),
    })
    .where(eq(dealersTable.id, params.data.id))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Dealer not found" });
    return;
  }
  // Lifecycle transitions are audited; suspension also disables the
  // dealership's AI agents automatically.
  if (body.data.status !== undefined && body.data.status !== before.status) {
    if (updated.status === "suspended") {
      const paused = await pauseDealerAgents(updated.id);
      await platformAudit(res, {
        action: "suspend",
        entityType: "dealer",
        entityId: updated.id,
        summary: `${res.locals.user?.name ?? "Super admin"} suspended dealership "${updated.name}" (data plane frozen, ${paused} agents paused)`,
        details: { dealerId: updated.id, agentsPaused: paused },
      });
    } else {
      await platformAudit(res, {
        action: "activate",
        entityType: "dealer",
        entityId: updated.id,
        summary: `${res.locals.user?.name ?? "Super admin"} reactivated dealership "${updated.name}" (agents stay paused until re-enabled)`,
        details: { dealerId: updated.id },
      });
    }
  }
  const full = await dealerWithCount(updated.id);
  res.json(UpdateDealerResponse.parse(full));
});

router.get(
  "/platform/dealers/:id/agents",
  async (req, res): Promise<void> => {
    const params = ListDealerAgentsParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const dealer = await dealerWithCount(params.data.id);
    if (!dealer) {
      res.status(404).json({ error: "Dealer not found" });
      return;
    }
    const rows = await db
      .select()
      .from(agentsTable)
      .where(eq(agentsTable.dealerId, params.data.id))
      .orderBy(asc(agentsTable.id));
    res.json(ListDealerAgentsResponse.parse(rows));
  },
);

router.patch(
  "/platform/dealers/:id/agents/:agentId",
  async (req, res): Promise<void> => {
    const params = UpdateDealerAgentParams.safeParse(req.params);
    const body = UpdateDealerAgentBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const [agent] = await db
      .update(agentsTable)
      .set(body.data)
      .where(
        and(
          eq(agentsTable.id, params.data.agentId),
          eq(agentsTable.dealerId, params.data.id),
        ),
      )
      .returning();
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await platformAudit(res, {
      action: "update",
      entityType: "agent",
      entityId: agent.id,
      summary: `${res.locals.user?.name ?? "Super admin"} set agent "${agent.name}" to ${agent.status} for dealer #${params.data.id}`,
      details: { dealerId: params.data.id, agentKey: agent.key, status: agent.status },
    });
    res.json(UpdateDealerAgentResponse.parse(agent));
  },
);

router.get("/platform/audit", async (req, res): Promise<void> => {
  const query = ListPlatformAuditQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const limit = Math.min(Math.max(query.data.limit ?? 100, 1), 500);
  const rows = await db
    .select()
    .from(auditLogsTable)
    .where(
      query.data.dealerId !== undefined
        ? eq(auditLogsTable.dealerId, query.data.dealerId)
        : isNull(auditLogsTable.dealerId),
    )
    .orderBy(desc(auditLogsTable.createdAt))
    .limit(limit);
  res.json(ListPlatformAuditResponse.parse(rows));
});

router.post("/platform/impersonation", async (req, res): Promise<void> => {
  const body = StartImpersonationBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const user = res.locals.user!;
  const [dealer] = await db
    .select({ id: dealersTable.id, name: dealersTable.name })
    .from(dealersTable)
    .where(eq(dealersTable.id, body.data.dealerId));
  if (!dealer) {
    res.status(404).json({ error: "Dealer not found" });
    return;
  }
  const expiresAt = new Date(Date.now() + IMPERSONATION_TTL_MS);
  const [grant] = await db
    .insert(impersonationGrantsTable)
    .values({
      userId: user.id,
      dealerId: dealer.id,
      reason: body.data.reason ?? null,
      expiresAt,
    })
    .returning();
  invalidateGrantCache();
  await platformAudit(res, {
    action: "impersonate",
    entityType: "dealer",
    entityId: dealer.id,
    summary: `${user.name ?? user.email ?? "Super admin"} started an impersonation window for dealership "${dealer.name}" (expires ${expiresAt.toISOString()})`,
    details: {
      dealerId: dealer.id,
      grantId: grant!.id,
      reason: body.data.reason ?? null,
      expiresAt: expiresAt.toISOString(),
    },
  });
  res.status(201).json(
    StartImpersonationResponse.parse({
      id: grant!.id,
      dealerId: grant!.dealerId,
      expiresAt: grant!.expiresAt,
    }),
  );
});

async function memberRows(dealerId: number) {
  return db
    .select({
      id: dealerUsersTable.id,
      userId: dealerUsersTable.userId,
      dealerId: dealerUsersTable.dealerId,
      roleId: dealerUsersTable.roleId,
      roleName: rolesTable.name,
      isGeneralManager: dealerUsersTable.isGeneralManager,
      email: usersTable.email,
      name: usersTable.name,
      imageUrl: usersTable.imageUrl,
      userStatus: usersTable.status,
    })
    .from(dealerUsersTable)
    .innerJoin(usersTable, eq(dealerUsersTable.userId, usersTable.id))
    .leftJoin(rolesTable, eq(dealerUsersTable.roleId, rolesTable.id))
    .where(eq(dealerUsersTable.dealerId, dealerId))
    .orderBy(asc(dealerUsersTable.id));
}

router.get(
  "/platform/dealers/:id/members",
  async (req, res): Promise<void> => {
    const params = ListDealerMembersParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const dealer = await dealerWithCount(params.data.id);
    if (!dealer) {
      res.status(404).json({ error: "Dealer not found" });
      return;
    }
    res.json(ListDealerMembersResponse.parse(await memberRows(params.data.id)));
  },
);

router.post(
  "/platform/dealers/:id/members",
  async (req, res): Promise<void> => {
    const params = AddDealerMemberParams.safeParse(req.params);
    const body = AddDealerMemberBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const dealer = await dealerWithCount(params.data.id);
    if (!dealer) {
      res.status(404).json({ error: "Dealer not found" });
      return;
    }
    const [role] = await db
      .select({ id: rolesTable.id })
      .from(rolesTable)
      .where(eq(rolesTable.id, body.data.roleId));
    if (!role) {
      res.status(422).json({ error: "Unknown role" });
      return;
    }
    let userId = body.data.userId ?? null;
    if (userId == null && body.data.email) {
      const [byEmail] = await db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(
          sql`lower(${usersTable.email}) = ${body.data.email.toLowerCase()}`,
        );
      userId = byEmail?.id ?? null;
    }
    if (userId == null) {
      res.status(404).json({
        error:
          "No user found. Ask them to sign up first, then add them by email.",
      });
      return;
    }
    const [user] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.id, userId));
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    const isGM = body.data.isGeneralManager ?? false;
    if (isGM) {
      await db
        .update(dealerUsersTable)
        .set({ isGeneralManager: false })
        .where(eq(dealerUsersTable.dealerId, params.data.id));
    }
    await db
      .insert(dealerUsersTable)
      .values({
        dealerId: params.data.id,
        userId,
        roleId: body.data.roleId,
        isGeneralManager: isGM,
      })
      .onConflictDoUpdate({
        target: [dealerUsersTable.dealerId, dealerUsersTable.userId],
        set: { roleId: body.data.roleId, isGeneralManager: isGM },
      });
    const rows = await memberRows(params.data.id);
    const member = rows.find((m) => m.userId === userId);
    res.status(201).json(AddDealerMemberResponse.parse(member));
  },
);

router.patch(
  "/platform/dealers/:id/members/:userId",
  async (req, res): Promise<void> => {
    const params = UpdateDealerMemberParams.safeParse(req.params);
    const body = UpdateDealerMemberBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const isGM = body.data.isGeneralManager ?? false;
    if (isGM) {
      await db
        .update(dealerUsersTable)
        .set({ isGeneralManager: false })
        .where(eq(dealerUsersTable.dealerId, params.data.id));
    }
    const [updated] = await db
      .update(dealerUsersTable)
      .set({ roleId: body.data.roleId, isGeneralManager: isGM })
      .where(
        and(
          eq(dealerUsersTable.dealerId, params.data.id),
          eq(dealerUsersTable.userId, params.data.userId),
        ),
      )
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Membership not found" });
      return;
    }
    const rows = await memberRows(params.data.id);
    const member = rows.find((m) => m.userId === params.data.userId);
    res.json(UpdateDealerMemberResponse.parse(member));
  },
);

router.delete(
  "/platform/dealers/:id/members/:userId",
  async (req, res): Promise<void> => {
    const params = RemoveDealerMemberParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const deleted = await db
      .delete(dealerUsersTable)
      .where(
        and(
          eq(dealerUsersTable.dealerId, params.data.id),
          eq(dealerUsersTable.userId, params.data.userId),
        ),
      )
      .returning();
    if (deleted.length === 0) {
      res.status(404).json({ error: "Membership not found" });
      return;
    }
    res.status(204).end();
  },
);

router.get("/platform/users", async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      id: usersTable.id,
      clerkId: usersTable.clerkId,
      email: usersTable.email,
      name: usersTable.name,
      imageUrl: usersTable.imageUrl,
      status: usersTable.status,
      createdAt: usersTable.createdAt,
      dealerCount: sql<number>`(select count(*)::int from ${dealerUsersTable} where ${dealerUsersTable.userId} = ${usersTable.id})`,
    })
    .from(usersTable)
    .orderBy(asc(usersTable.createdAt));
  res.json(ListPlatformUsersResponse.parse(rows));
});

export default router;
