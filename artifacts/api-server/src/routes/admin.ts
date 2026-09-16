import { Router, type IRouter } from "express";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  db,
  dealersTable,
  usersTable,
  rolesTable,
  rolePermissionsTable,
  dealerUsersTable,
  divisionsTable,
  roleFieldPermissionsTable,
  leadSourcesTable,
  stageChecklistsTable,
  dealerTaxesTable,
  PERMISSION_MODULES,
  PERMISSION_CATEGORIES,
  FIELD_GROUPS,
  FIELD_GROUP_KEYS,
  CHECKLIST_STAGES,
  type ChecklistStage,
} from "@workspace/db";
import { ensureDealerTaxes } from "../lib/taxes";
import {
  dealerTimezone,
  invalidateDealerTimezone,
  isValidTimezone,
  zonedDayKey,
} from "../lib/timezone";
import {
  getServiceSettings,
  updateServiceSettings,
} from "../lib/service-settings";
import {
  GetServiceSettingsResponse,
  UpdateServiceSettingsBody,
  UpdateServiceSettingsResponse,
  ListAdminUsersResponse,
  AddAdminUserBody,
  AddAdminUserResponse,
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
  SetRoleFieldPermissionsParams,
  SetRoleFieldPermissionsBody,
  SetRoleFieldPermissionsResponse,
  GetPermissionMetaResponse,
  GetDealerBrandingResponse,
  UpdateDealerBrandingBody,
  UpdateDealerBrandingResponse,
  GetDealerLocalizationResponse,
  UpdateDealerLocalizationBody,
  UpdateDealerLocalizationResponse,
  ListAdminLeadSourcesResponse,
  CreateAdminLeadSourceBody,
  CreateAdminLeadSourceResponse,
  UpdateAdminLeadSourceParams,
  UpdateAdminLeadSourceBody,
  UpdateAdminLeadSourceResponse,
  ListStageChecklistsResponse,
  SetStageChecklistParams,
  SetStageChecklistBody,
  SetStageChecklistResponse,
  ListDealerTaxesResponse,
  CreateDealerTaxBody,
  CreateDealerTaxResponse,
  UpdateDealerTaxParams,
  UpdateDealerTaxBody,
  UpdateDealerTaxResponse,
  DeleteDealerTaxParams,
} from "@workspace/api-zod";
import {
  invalidatePermCache,
  activeDealerId,
  requireSuperAdmin,
} from "../middlewares/rbac";
import { invalidateFieldPermCache } from "../lib/field-permissions";
import { ensureLeadSources, slugifyCode } from "../lib/lead-sources";
import {
  currentChecklistItems,
  getAllActiveChecklists,
  getActiveChecklist,
} from "../lib/stage-checklists";

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
  const fieldPermissions = await db
    .select({
      fieldGroup: roleFieldPermissionsTable.fieldGroup,
      access: roleFieldPermissionsTable.access,
    })
    .from(roleFieldPermissionsTable)
    .where(eq(roleFieldPermissionsTable.roleId, roleId));
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(dealerUsersTable)
    .where(eq(dealerUsersTable.roleId, roleId));
  return { ...role, userCount: count, permissions, fieldPermissions };
}

// Settings → Users is dealer-scoped: it lists and manages the ACTIVE dealer's
// members only. Role assignment edits the dealer membership, not the user row.
const managerUsers = alias(usersTable, "manager_users");

router.get("/admin/users", async (_req, res): Promise<void> => {
  const dealerId = activeDealerId(res);
  const rows = await db
    .select({
      id: usersTable.id,
      clerkId: usersTable.clerkId,
      email: usersTable.email,
      name: usersTable.name,
      phone: usersTable.phone,
      imageUrl: usersTable.imageUrl,
      roleId: dealerUsersTable.roleId,
      roleName: rolesTable.name,
      status: usersTable.status,
      reportingManagerUserId: dealerUsersTable.reportingManagerUserId,
      reportingManagerName: managerUsers.name,
      divisionId: dealerUsersTable.divisionId,
      divisionName: divisionsTable.name,
      lastLoginAt: usersTable.lastLoginAt,
      createdAt: usersTable.createdAt,
    })
    .from(dealerUsersTable)
    .innerJoin(usersTable, eq(dealerUsersTable.userId, usersTable.id))
    .leftJoin(rolesTable, eq(dealerUsersTable.roleId, rolesTable.id))
    .leftJoin(
      managerUsers,
      eq(dealerUsersTable.reportingManagerUserId, managerUsers.id),
    )
    .leftJoin(divisionsTable, eq(dealerUsersTable.divisionId, divisionsTable.id))
    .where(eq(dealerUsersTable.dealerId, dealerId))
    .orderBy(asc(usersTable.createdAt));
  res.json(ListAdminUsersResponse.parse(rows));
});

// GM (or super admin) adds an already-registered user to the ACTIVE dealer.
router.post("/admin/users", async (req, res): Promise<void> => {
  const dealerId = activeDealerId(res);
  const body = AddAdminUserBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const email = body.data.email.trim().toLowerCase();
  const [user] = await db
    .select()
    .from(usersTable)
    .where(sql`lower(${usersTable.email}) = ${email}`);
  if (!user) {
    res.status(404).json({
      error:
        "No account found with that email. Ask them to sign up first, then add them here.",
    });
    return;
  }
  const [role] = await db
    .select()
    .from(rolesTable)
    .where(eq(rolesTable.id, body.data.roleId));
  if (!role) {
    res.status(404).json({ error: "Role not found" });
    return;
  }
  const [existing] = await db
    .select()
    .from(dealerUsersTable)
    .where(
      and(
        eq(dealerUsersTable.dealerId, dealerId),
        eq(dealerUsersTable.userId, user.id),
      ),
    );
  if (existing) {
    res.status(409).json({ error: "This user is already a member of this dealership" });
    return;
  }
  await db.insert(dealerUsersTable).values({
    dealerId,
    userId: user.id,
    roleId: role.id,
  });
  invalidatePermCache();
  res.status(201).json(
    AddAdminUserResponse.parse({
      id: user.id,
      clerkId: user.clerkId,
      email: user.email,
      name: user.name,
      phone: user.phone,
      imageUrl: user.imageUrl,
      roleId: role.id,
      roleName: role.name,
      status: user.status,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
    }),
  );
});

router.patch("/admin/users/:id", async (req, res): Promise<void> => {
  const dealerId = activeDealerId(res);
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

  const [membership] = await db
    .select()
    .from(dealerUsersTable)
    .where(
      and(
        eq(dealerUsersTable.dealerId, dealerId),
        eq(dealerUsersTable.userId, params.data.id),
      ),
    );
  if (!membership) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  // Employee-master fields (manager, division) live on the dealer membership.
  const membershipPatch: Partial<{
    roleId: number;
    reportingManagerUserId: number | null;
    divisionId: number | null;
  }> = {};
  if (body.data.roleId !== undefined && body.data.roleId !== null) {
    membershipPatch.roleId = body.data.roleId;
  }
  if (body.data.reportingManagerUserId !== undefined) {
    const managerId = body.data.reportingManagerUserId;
    if (managerId != null) {
      if (managerId === params.data.id) {
        res.status(400).json({ error: "A member cannot report to themselves" });
        return;
      }
      const [managerMembership] = await db
        .select({ id: dealerUsersTable.id })
        .from(dealerUsersTable)
        .where(
          and(
            eq(dealerUsersTable.dealerId, dealerId),
            eq(dealerUsersTable.userId, managerId),
          ),
        );
      if (!managerMembership) {
        res
          .status(400)
          .json({ error: "Reporting manager must be a member of this dealership" });
        return;
      }
    }
    membershipPatch.reportingManagerUserId = managerId;
  }
  if (body.data.divisionId !== undefined) {
    const divisionId = body.data.divisionId;
    if (divisionId != null) {
      const [division] = await db
        .select({ id: divisionsTable.id })
        .from(divisionsTable)
        .where(
          and(
            eq(divisionsTable.id, divisionId),
            eq(divisionsTable.dealerId, dealerId),
          ),
        );
      if (!division) {
        res.status(400).json({ error: "Division not found for this dealership" });
        return;
      }
    }
    membershipPatch.divisionId = divisionId;
  }
  if (Object.keys(membershipPatch).length > 0) {
    await db
      .update(dealerUsersTable)
      .set(membershipPatch)
      .where(eq(dealerUsersTable.id, membership.id));
  }

  const [updated] = await db
    .update(usersTable)
    .set({
      ...(body.data.status !== undefined ? { status: body.data.status } : {}),
      ...(body.data.phone !== undefined
        ? { phone: body.data.phone?.trim() || null }
        : {}),
      updatedBy: res.locals.user?.clerkId ?? null,
      updatedAt: new Date(),
    })
    .where(eq(usersTable.id, params.data.id))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const roleId = body.data.roleId ?? membership.roleId;
  let roleName: string | null = null;
  if (roleId != null) {
    const [role] = await db
      .select({ name: rolesTable.name })
      .from(rolesTable)
      .where(eq(rolesTable.id, roleId));
    roleName = role?.name ?? null;
  }

  const reportingManagerUserId =
    membershipPatch.reportingManagerUserId !== undefined
      ? membershipPatch.reportingManagerUserId
      : membership.reportingManagerUserId;
  const divisionId =
    membershipPatch.divisionId !== undefined
      ? membershipPatch.divisionId
      : membership.divisionId;
  let reportingManagerName: string | null = null;
  if (reportingManagerUserId != null) {
    const [m] = await db
      .select({ name: usersTable.name })
      .from(usersTable)
      .where(eq(usersTable.id, reportingManagerUserId));
    reportingManagerName = m?.name ?? null;
  }
  let divisionName: string | null = null;
  if (divisionId != null) {
    const [d] = await db
      .select({ name: divisionsTable.name })
      .from(divisionsTable)
      .where(eq(divisionsTable.id, divisionId));
    divisionName = d?.name ?? null;
  }

  res.json(
    UpdateAdminUserResponse.parse({
      ...updated,
      roleId,
      roleName,
      reportingManagerUserId,
      reportingManagerName,
      divisionId,
      divisionName,
    }),
  );
});

router.get("/admin/roles", async (_req, res): Promise<void> => {
  const roles = await db.select().from(rolesTable).orderBy(asc(rolesTable.id));
  const perms = await db.select().from(rolePermissionsTable);
  const counts = await db
    .select({
      roleId: dealerUsersTable.roleId,
      count: sql<number>`count(*)::int`,
    })
    .from(dealerUsersTable)
    .groupBy(dealerUsersTable.roleId);
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

// Role definitions are PLATFORM-wide (shared across dealers), so mutating them
// is restricted to the super admin.
router.post(
  "/admin/roles",
  requireSuperAdmin,
  async (req, res): Promise<void> => {
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
  },
);

router.patch(
  "/admin/roles/:id",
  requireSuperAdmin,
  async (req, res): Promise<void> => {
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
  },
);

router.delete(
  "/admin/roles/:id",
  requireSuperAdmin,
  async (req, res): Promise<void> => {
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
      .from(dealerUsersTable)
      .where(eq(dealerUsersTable.roleId, role.id));
    if (count > 0) {
      res.status(400).json({
        error: `Role is assigned to ${count} user(s); reassign them first`,
      });
      return;
    }
    await db.delete(rolesTable).where(eq(rolesTable.id, role.id));
    invalidatePermCache(role.id);
    res.status(204).end();
  },
);

router.put(
  "/admin/roles/:id/permissions",
  requireSuperAdmin,
  async (req, res): Promise<void> => {
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
  },
);

router.get("/admin/permission-meta", async (_req, res): Promise<void> => {
  res.json(
    GetPermissionMetaResponse.parse({
      modules: [...PERMISSION_MODULES],
      categories: [...PERMISSION_CATEGORIES],
      fieldGroups: FIELD_GROUPS.map((g) => ({
        key: g.key,
        label: g.label,
        module: g.module,
        fields: [...g.fields],
      })),
    }),
  );
});

// Field-level access grants are attached to platform-wide roles, so mutating
// them is super-admin only (consistent with the permission matrix PUT).
router.put(
  "/admin/roles/:id/field-permissions",
  requireSuperAdmin,
  async (req, res): Promise<void> => {
    const params = SetRoleFieldPermissionsParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const body = SetRoleFieldPermissionsBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    const unknown = body.data.grants.find(
      (g) => !FIELD_GROUP_KEYS.includes(g.fieldGroup),
    );
    if (unknown) {
      res.status(400).json({ error: `Unknown field group: ${unknown.fieldGroup}` });
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
        .delete(roleFieldPermissionsTable)
        .where(eq(roleFieldPermissionsTable.roleId, role.id));
      // "edit" is the default — only persist actual restrictions.
      const restricted = body.data.grants.filter((g) => g.access !== "edit");
      if (restricted.length > 0) {
        await tx.insert(roleFieldPermissionsTable).values(
          restricted.map((g) => ({
            roleId: role.id,
            fieldGroup: g.fieldGroup,
            access: g.access,
          })),
        );
      }
    });
    invalidateFieldPermCache(role.id);
    const full = await roleWithPermissions(role.id);
    res.json(SetRoleFieldPermissionsResponse.parse(full));
  },
);

// ————— Lead sources (dealer-scoped config) —————

router.get("/admin/lead-sources", async (_req, res): Promise<void> => {
  const dealerId = activeDealerId(res);
  const rows = await ensureLeadSources(dealerId);
  res.json(ListAdminLeadSourcesResponse.parse(rows));
});

router.post("/admin/lead-sources", async (req, res): Promise<void> => {
  const dealerId = activeDealerId(res);
  const body = CreateAdminLeadSourceBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  await ensureLeadSources(dealerId);
  const code = slugifyCode(body.data.code || body.data.name);
  if (!code) {
    res.status(400).json({ error: "Source name must contain letters or digits" });
    return;
  }
  const [existing] = await db
    .select({ id: leadSourcesTable.id })
    .from(leadSourcesTable)
    .where(
      and(eq(leadSourcesTable.dealerId, dealerId), eq(leadSourcesTable.code, code)),
    );
  if (existing) {
    res.status(409).json({ error: `A source with code "${code}" already exists` });
    return;
  }
  const [{ maxOrder }] = await db
    .select({ maxOrder: sql<number>`coalesce(max(${leadSourcesTable.sortOrder}), 0)::int` })
    .from(leadSourcesTable)
    .where(eq(leadSourcesTable.dealerId, dealerId));
  const [created] = await db
    .insert(leadSourcesTable)
    .values({
      dealerId,
      code,
      name: body.data.name,
      isSocial: body.data.isSocial ?? false,
      active: body.data.active ?? true,
      sortOrder: body.data.sortOrder ?? maxOrder + 1,
    })
    .returning();
  res.status(201).json(CreateAdminLeadSourceResponse.parse(created));
});

router.patch("/admin/lead-sources/:id", async (req, res): Promise<void> => {
  const dealerId = activeDealerId(res);
  const params = UpdateAdminLeadSourceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = UpdateAdminLeadSourceBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const [updated] = await db
    .update(leadSourcesTable)
    .set({
      ...(body.data.name !== undefined ? { name: body.data.name } : {}),
      ...(body.data.isSocial !== undefined ? { isSocial: body.data.isSocial } : {}),
      ...(body.data.active !== undefined ? { active: body.data.active } : {}),
      ...(body.data.sortOrder !== undefined
        ? { sortOrder: body.data.sortOrder }
        : {}),
    })
    .where(
      and(
        eq(leadSourcesTable.id, params.data.id),
        eq(leadSourcesTable.dealerId, dealerId),
      ),
    )
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Lead source not found" });
    return;
  }
  res.json(UpdateAdminLeadSourceResponse.parse(updated));
});

// ————— Stage checklists (versioned, dealer-scoped) —————

router.get("/admin/stage-checklists", async (_req, res): Promise<void> => {
  const dealerId = activeDealerId(res);
  const configs = await getAllActiveChecklists(dealerId);
  res.json(ListStageChecklistsResponse.parse(configs));
});

router.put("/admin/stage-checklists/:stage", async (req, res): Promise<void> => {
  const dealerId = activeDealerId(res);
  const params = SetStageChecklistParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = SetStageChecklistBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const stage = params.data.stage as ChecklistStage;
  if (!CHECKLIST_STAGES.includes(stage)) {
    res.status(400).json({ error: "Unknown stage" });
    return;
  }
  // Versioned: every save is a NEW row; history is never rewritten.
  const current = await getActiveChecklist(dealerId, stage);
  const items = currentChecklistItems(body.data.items);
  const [saved] = await db
    .insert(stageChecklistsTable)
    .values({
      dealerId,
      stage,
      version: current.version + 1,
      items,
      createdBy: res.locals.user?.clerkId ?? null,
    })
    .returning();
  res.json(
    SetStageChecklistResponse.parse({
      stage,
      version: saved!.version,
      items: saved!.items,
      updatedBy: saved!.createdBy,
      updatedAt: saved!.createdAt,
    }),
  );
});

// ————— Dealer service settings (interval + late-service surcharge) —————

router.get("/admin/service-settings", async (_req, res): Promise<void> => {
  const settings = await getServiceSettings(activeDealerId(res));
  res.json(GetServiceSettingsResponse.parse(settings));
});

router.patch("/admin/service-settings", async (req, res): Promise<void> => {
  const body = UpdateServiceSettingsBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  let settings;
  try {
    settings = await updateServiceSettings(activeDealerId(res), body.data);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Labour USD to GYD rate must be a positive finite number"
    ) {
      res.status(422).json({ error: error.message });
      return;
    }
    throw error;
  }
  res.json(UpdateServiceSettingsResponse.parse(settings));
});

// ————— Dealer taxes (deterministic config) —————

router.get("/admin/taxes", async (_req, res): Promise<void> => {
  const dealerId = activeDealerId(res);
  const rows = await ensureDealerTaxes(dealerId);
  res.json(ListDealerTaxesResponse.parse(rows));
});

/** Orval coerces `format: date` to Date; DB column wants YYYY-MM-DD strings. */
function toDateOnly(value: Date | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value.slice(0, 10);
}

router.post("/admin/taxes", async (req, res): Promise<void> => {
  const dealerId = activeDealerId(res);
  const body = CreateDealerTaxBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  await ensureDealerTaxes(dealerId);
  const code = slugifyCode(body.data.code || body.data.name);
  const [{ maxOrder }] = await db
    .select({ maxOrder: sql<number>`coalesce(max(${dealerTaxesTable.sortOrder}), 0)::int` })
    .from(dealerTaxesTable)
    .where(eq(dealerTaxesTable.dealerId, dealerId));
  const [created] = await db
    .insert(dealerTaxesTable)
    .values({
      dealerId,
      name: body.data.name,
      code: code || "tax",
      kind: body.data.kind,
      rate: body.data.rate,
      thresholdAmount: body.data.thresholdAmount ?? null,
      excludeEv: body.data.excludeEv ?? false,
      effectiveFrom:
        toDateOnly(body.data.effectiveFrom) ??
        zonedDayKey(new Date(), await dealerTimezone(dealerId)),
      active: body.data.active ?? true,
      sortOrder: body.data.sortOrder ?? maxOrder + 1,
      notes: body.data.notes ?? null,
      createdBy: res.locals.user?.clerkId ?? null,
    })
    .returning();
  res.status(201).json(CreateDealerTaxResponse.parse(created));
});

router.patch("/admin/taxes/:id", async (req, res): Promise<void> => {
  const dealerId = activeDealerId(res);
  const params = UpdateDealerTaxParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = UpdateDealerTaxBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const effectiveFrom = toDateOnly(body.data.effectiveFrom);
  const [updated] = await db
    .update(dealerTaxesTable)
    .set({
      ...(body.data.name !== undefined ? { name: body.data.name } : {}),
      ...(body.data.kind !== undefined ? { kind: body.data.kind } : {}),
      ...(body.data.rate !== undefined ? { rate: body.data.rate } : {}),
      ...(body.data.thresholdAmount !== undefined
        ? { thresholdAmount: body.data.thresholdAmount }
        : {}),
      ...(body.data.excludeEv !== undefined
        ? { excludeEv: body.data.excludeEv }
        : {}),
      ...(effectiveFrom !== undefined ? { effectiveFrom } : {}),
      ...(body.data.active !== undefined ? { active: body.data.active } : {}),
      ...(body.data.sortOrder !== undefined
        ? { sortOrder: body.data.sortOrder }
        : {}),
      ...(body.data.notes !== undefined ? { notes: body.data.notes } : {}),
    })
    .where(
      and(
        eq(dealerTaxesTable.id, params.data.id),
        eq(dealerTaxesTable.dealerId, dealerId),
      ),
    )
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Tax rule not found" });
    return;
  }
  res.json(UpdateDealerTaxResponse.parse(updated));
});

router.delete("/admin/taxes/:id", async (req, res): Promise<void> => {
  const dealerId = activeDealerId(res);
  const params = DeleteDealerTaxParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const deleted = await db
    .delete(dealerTaxesTable)
    .where(
      and(
        eq(dealerTaxesTable.id, params.data.id),
        eq(dealerTaxesTable.dealerId, dealerId),
      ),
    )
    .returning();
  if (deleted.length === 0) {
    res.status(404).json({ error: "Tax rule not found" });
    return;
  }
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// White-label branding (GM only)
// ---------------------------------------------------------------------------

/** Only a general manager of the ACTIVE dealership may read/change branding. */
function requireGeneralManager(res: Parameters<typeof activeDealerId>[0]): boolean {
  const user = res.locals.user;
  const dealerId = activeDealerId(res);
  const membership = user?.dealers.find((d) => d.dealerId === dealerId);
  return (
    user?.isSuperAdmin === true ||
    membership?.isGeneralManager === true ||
    membership?.roleName === "General Manager"
  );
}

router.get("/admin/branding", async (_req, res): Promise<void> => {
  if (!requireGeneralManager(res)) {
    res.status(403).json({ error: "Only the general manager can manage branding" });
    return;
  }
  const dealerId = activeDealerId(res);
  const [dealer] = await db
    .select({
      dealerId: dealersTable.id,
      dealerName: dealersTable.name,
      brandName: dealersTable.brandName,
      logoUrl: dealersTable.logoUrl,
    })
    .from(dealersTable)
    .where(eq(dealersTable.id, dealerId));
  if (!dealer) {
    res.status(404).json({ error: "Dealership not found" });
    return;
  }
  res.json(GetDealerBrandingResponse.parse(dealer));
});

router.patch("/admin/branding", async (req, res): Promise<void> => {
  if (!requireGeneralManager(res)) {
    res.status(403).json({ error: "Only the general manager can manage branding" });
    return;
  }
  const dealerId = activeDealerId(res);
  const body = UpdateDealerBrandingBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const updates: { brandName?: string | null; logoUrl?: string | null } = {};
  if ("brandName" in (req.body ?? {})) {
    const trimmed = body.data.brandName?.trim();
    updates.brandName = trimmed ? trimmed : null;
  }
  if ("logoUrl" in (req.body ?? {})) {
    const logoUrl = body.data.logoUrl ?? null;
    // The logo must be an object THIS dealer uploaded — the serve route only
    // streams `uploads/dealer-{id}/` keys to members of that dealership.
    if (
      logoUrl !== null &&
      !logoUrl.startsWith(`/objects/uploads/dealer-${dealerId}/`)
    ) {
      res.status(422).json({ error: "Logo must be uploaded through the branding upload flow" });
      return;
    }
    updates.logoUrl = logoUrl;
  }
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "Nothing to update" });
    return;
  }
  const [updated] = await db
    .update(dealersTable)
    .set(updates)
    .where(eq(dealersTable.id, dealerId))
    .returning({
      dealerId: dealersTable.id,
      dealerName: dealersTable.name,
      brandName: dealersTable.brandName,
      logoUrl: dealersTable.logoUrl,
    });
  if (!updated) {
    res.status(404).json({ error: "Dealership not found" });
    return;
  }
  res.json(UpdateDealerBrandingResponse.parse(updated));
});

// ---------------------------------------------------------------------------
// Localization — dealership timezone (GM only). Changes are audited by the
// auditTrail middleware; the timezone cache is invalidated so every date
// rendered after the save uses the new zone immediately.
// ---------------------------------------------------------------------------

router.get("/admin/localization", async (_req, res): Promise<void> => {
  if (!requireGeneralManager(res)) {
    res.status(403).json({ error: "Only the general manager can manage localization" });
    return;
  }
  const dealerId = activeDealerId(res);
  const [dealer] = await db
    .select({ dealerId: dealersTable.id, timezone: dealersTable.timezone })
    .from(dealersTable)
    .where(eq(dealersTable.id, dealerId));
  if (!dealer) {
    res.status(404).json({ error: "Dealership not found" });
    return;
  }
  res.json(GetDealerLocalizationResponse.parse(dealer));
});

router.patch("/admin/localization", async (req, res): Promise<void> => {
  if (!requireGeneralManager(res)) {
    res.status(403).json({ error: "Only the general manager can manage localization" });
    return;
  }
  const dealerId = activeDealerId(res);
  const body = UpdateDealerLocalizationBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const timezone = body.data.timezone.trim();
  if (!isValidTimezone(timezone)) {
    res.status(422).json({
      error: `"${timezone}" is not a recognized IANA timezone identifier`,
    });
    return;
  }
  const [updated] = await db
    .update(dealersTable)
    .set({ timezone })
    .where(eq(dealersTable.id, dealerId))
    .returning({ dealerId: dealersTable.id, timezone: dealersTable.timezone });
  if (!updated) {
    res.status(404).json({ error: "Dealership not found" });
    return;
  }
  invalidateDealerTimezone(dealerId);
  res.json(UpdateDealerLocalizationResponse.parse(updated));
});

export default router;
