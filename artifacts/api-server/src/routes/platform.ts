import { Router, type IRouter } from "express";
import { asc, eq, sql, and } from "drizzle-orm";
import {
  db,
  dealersTable,
  dealerUsersTable,
  usersTable,
  rolesTable,
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
} from "@workspace/api-zod";

// All /platform routes are gated to the super admin in middlewares/rbac.ts
// (authorize short-circuits the "platform" segment on user.isSuperAdmin).
const router: IRouter = Router();

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
  const [existing] = await db
    .select({ id: dealersTable.id })
    .from(dealersTable)
    .where(eq(dealersTable.name, body.data.name.trim()));
  if (existing) {
    res.status(422).json({ error: "A dealer with this name already exists" });
    return;
  }
  const [created] = await db
    .insert(dealersTable)
    .values({
      name: body.data.name.trim(),
      city: body.data.city ?? null,
      country: body.data.country ?? null,
      status: body.data.status ?? "active",
      ...(body.data.usdExchangeRate !== undefined
        ? { usdExchangeRate: body.data.usdExchangeRate }
        : {}),
      createdBy: res.locals.user?.clerkId ?? null,
    })
    .returning();
  res
    .status(201)
    .json(CreateDealerResponse.parse({ ...created!, userCount: 0 }));
});

router.patch("/platform/dealers/:id", async (req, res): Promise<void> => {
  const params = UpdateDealerParams.safeParse(req.params);
  const body = UpdateDealerBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid input" });
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
    })
    .where(eq(dealersTable.id, params.data.id))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Dealer not found" });
    return;
  }
  const full = await dealerWithCount(updated.id);
  res.json(UpdateDealerResponse.parse(full));
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
