import { Router, type IRouter } from "express";
import { asc, desc, eq, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  rolesTable,
  rolePermissionsTable,
  PERMISSION_MODULES,
  PERMISSION_CATEGORIES,
} from "@workspace/db";
import {
  ListAdminUsersResponse,
  UpdateAdminUserParams,
  UpdateAdminUserBody,
  UpdateAdminUserResponse,
  ListAdminRolesResponse,
  CreateAdminRoleBody,
  CreateAdminRoleResponse,
  UpdateAdminRoleParams,
  UpdateAdminRoleBody,
  UpdateAdminRoleResponse,
  DeleteAdminRoleParams,
  SetRolePermissionsParams,
  SetRolePermissionsBody,
  SetRolePermissionsResponse,
  GetPermissionMetaResponse,
} from "@workspace/api-zod";
import { invalidatePermCache } from "../middlewares/rbac";

const router: IRouter = Router();

async function roleWithPermissions(roleId: number) {
  const [role] = await db
    .select()
    .from(rolesTable)
    .where(eq(rolesTable.id, roleId));
  if (!role) return null;
  const permissions = await db
    .select({
      module: rolePermissionsTable.module,
      category: rolePermissionsTable.category,
    })
    .from(rolePermissionsTable)
    .where(eq(rolePermissionsTable.roleId, roleId));
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(usersTable)
    .where(eq(usersTable.roleId, roleId));
  return { ...role, userCount: count, permissions };
}

router.get("/admin/users", async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      id: usersTable.id,
      clerkId: usersTable.clerkId,
      email: usersTable.email,
      name: usersTable.name,
      imageUrl: usersTable.imageUrl,
      roleId: usersTable.roleId,
      roleName: rolesTable.name,
      status: usersTable.status,
      lastLoginAt: usersTable.lastLoginAt,
      createdAt: usersTable.createdAt,
    })
    .from(usersTable)
    .leftJoin(rolesTable, eq(usersTable.roleId, rolesTable.id))
    .orderBy(asc(usersTable.createdAt));
  res.json(ListAdminUsersResponse.parse(rows));
});

router.patch("/admin/users/:id", async (req, res): Promise<void> => {
  const params = UpdateAdminUserParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = UpdateAdminUserBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [updated] = await db
    .update(usersTable)
    .set({
      ...(body.data.roleId !== undefined ? { roleId: body.data.roleId } : {}),
      ...(body.data.status !== undefined ? { status: body.data.status } : {}),
      updatedBy: res.locals.user?.clerkId ?? null,
      updatedAt: new Date(),
    })
    .where(eq(usersTable.id, params.data.id))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  let roleName: string | null = null;
  if (updated.roleId != null) {
    const [role] = await db
      .select({ name: rolesTable.name })
      .from(rolesTable)
      .where(eq(rolesTable.id, updated.roleId));
    roleName = role?.name ?? null;
  }

  res.json(UpdateAdminUserResponse.parse({ ...updated, roleName }));
});

router.get("/admin/roles", async (_req, res): Promise<void> => {
  const roles = await db.select().from(rolesTable).orderBy(asc(rolesTable.id));
  const perms = await db.select().from(rolePermissionsTable);
  const counts = await db
    .select({
      roleId: usersTable.roleId,
      count: sql<number>`count(*)::int`,
    })
    .from(usersTable)
    .groupBy(usersTable.roleId);
  const countMap = new Map(counts.map((c) => [c.roleId, c.count]));

  const result = roles.map((role) => ({
    ...role,
    userCount: countMap.get(role.id) ?? 0,
    permissions: perms
      .filter((p) => p.roleId === role.id)
      .map((p) => ({ module: p.module, category: p.category })),
  }));
  res.json(ListAdminRolesResponse.parse(result));
});

router.post("/admin/roles", async (req, res): Promise<void> => {
  const body = CreateAdminRoleBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const [created] = await db
    .insert(rolesTable)
    .values({
      name: body.data.name,
      description: body.data.description ?? null,
      isSystem: false,
      createdBy: res.locals.user?.clerkId ?? null,
    })
    .returning();
  const full = await roleWithPermissions(created!.id);
  res.status(201).json(CreateAdminRoleResponse.parse(full));
});

router.patch("/admin/roles/:id", async (req, res): Promise<void> => {
  const params = UpdateAdminRoleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = UpdateAdminRoleBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const [updated] = await db
    .update(rolesTable)
    .set({
      ...(body.data.name !== undefined ? { name: body.data.name } : {}),
      ...(body.data.description !== undefined
        ? { description: body.data.description }
        : {}),
      updatedBy: res.locals.user?.clerkId ?? null,
    })
    .where(eq(rolesTable.id, params.data.id))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Role not found" });
    return;
  }
  const full = await roleWithPermissions(updated.id);
  res.json(UpdateAdminRoleResponse.parse(full));
});

router.delete("/admin/roles/:id", async (req, res): Promise<void> => {
  const params = DeleteAdminRoleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [role] = await db
    .select()
    .from(rolesTable)
    .where(eq(rolesTable.id, params.data.id));
  if (!role) {
    res.status(404).json({ error: "Role not found" });
    return;
  }
  if (role.isSystem) {
    res.status(400).json({ error: "System roles cannot be deleted" });
    return;
  }
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(usersTable)
    .where(eq(usersTable.roleId, role.id));
  if (count > 0) {
    res
      .status(400)
      .json({ error: `Role is assigned to ${count} user(s); reassign them first` });
    return;
  }
  await db.delete(rolesTable).where(eq(rolesTable.id, role.id));
  invalidatePermCache(role.id);
  res.status(204).end();
});

router.put("/admin/roles/:id/permissions", async (req, res): Promise<void> => {
  const params = SetRolePermissionsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = SetRolePermissionsBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const [role] = await db
    .select()
    .from(rolesTable)
    .where(eq(rolesTable.id, params.data.id));
  if (!role) {
    res.status(404).json({ error: "Role not found" });
    return;
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(rolePermissionsTable)
      .where(eq(rolePermissionsTable.roleId, role.id));
    if (body.data.grants.length > 0) {
      await tx.insert(rolePermissionsTable).values(
        body.data.grants.map((g) => ({
          roleId: role.id,
          module: g.module,
          category: g.category,
        })),
      );
    }
  });
  invalidatePermCache(role.id);

  const full = await roleWithPermissions(role.id);
  res.json(SetRolePermissionsResponse.parse(full));
});

router.get("/admin/permission-meta", async (_req, res): Promise<void> => {
  res.json(
    GetPermissionMetaResponse.parse({
      modules: [...PERMISSION_MODULES],
      categories: [...PERMISSION_CATEGORIES],
    }),
  );
});

export default router;
