import type { Request, Response, NextFunction, RequestHandler } from "express";
import { getAuth, clerkClient } from "@clerk/express";
import { eq, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  rolesTable,
  rolePermissionsTable,
  auditLogsTable,
  dealersTable,
  dealerUsersTable,
  PERMISSION_MODULES,
  PERMISSION_CATEGORIES,
  type User,
  type PermissionModule,
  type PermissionCategory,
} from "@workspace/db";
import { logger } from "../lib/logger";

export type DealerMembership = {
  dealerId: number;
  dealerName: string;
  roleId: number;
  roleName: string | null;
  isGeneralManager: boolean;
};

export type AuthedUser = User & {
  roleName: string | null;
  permissions: { module: string; category: string }[];
  isSuperAdmin: boolean;
  dealerId: number | null;
  dealers: DealerMembership[];
};

declare global {
  namespace Express {
    interface Locals {
      user?: AuthedUser;
      dealerId?: number;
    }
  }
}

// Comma-separated list of platform administrator emails.
export const SUPER_ADMIN_EMAILS = (
  process.env.SUPER_ADMIN_EMAIL ?? "uday.valapudasu@theksquaregroup.com"
)
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

export function isSuperAdminEmail(email: string | null | undefined): boolean {
  return !!email && SUPER_ADMIN_EMAILS.includes(email.toLowerCase());
}

// Short-lived cache of role permissions to avoid a query on every request.
const permCache = new Map<
  number,
  { perms: { module: string; category: string }[]; ts: number }
>();
const PERM_TTL_MS = 15_000;

export function invalidatePermCache(roleId?: number) {
  if (roleId !== undefined) permCache.delete(roleId);
  else permCache.clear();
}

async function loadPermissions(roleId: number | null) {
  if (roleId == null) return [];
  const cached = permCache.get(roleId);
  if (cached && Date.now() - cached.ts < PERM_TTL_MS) return cached.perms;
  const rows = await db
    .select({
      module: rolePermissionsTable.module,
      category: rolePermissionsTable.category,
    })
    .from(rolePermissionsTable)
    .where(eq(rolePermissionsTable.roleId, roleId));
  permCache.set(roleId, { perms: rows, ts: Date.now() });
  return rows;
}

async function roleIdByName(name: string): Promise<number | null> {
  const [row] = await db
    .select({ id: rolesTable.id })
    .from(rolesTable)
    .where(eq(rolesTable.name, name));
  return row?.id ?? null;
}

async function provisionUser(clerkId: string): Promise<User> {
  const [existing] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.clerkId, clerkId));
  if (existing) return existing;

  let email: string | null = null;
  let name: string | null = null;
  let imageUrl: string | null = null;
  try {
    const cu = await clerkClient.users.getUser(clerkId);
    email = cu.primaryEmailAddress?.emailAddress ?? null;
    name =
      [cu.firstName, cu.lastName].filter(Boolean).join(" ") ||
      cu.username ||
      email;
    imageUrl = cu.imageUrl ?? null;
  } catch (err) {
    logger.warn({ err, clerkId }, "Failed to fetch Clerk profile");
  }

  // Multi-dealer: new users get NO global role and NO membership; the super
  // admin (matched by email) or a dealer GM assigns them to a dealer later.
  const [created] = await db
    .insert(usersTable)
    .values({ clerkId, email, name, imageUrl, roleId: null, createdBy: "system" })
    .onConflictDoNothing({ target: usersTable.clerkId })
    .returning();
  if (created) {
    await db.insert(auditLogsTable).values({
      actorUserId: created.id,
      actorClerkId: clerkId,
      actorName: name,
      actorEmail: email,
      action: "create",
      module: "settings",
      entityType: "user",
      entityId: String(created.id),
      summary: `User ${name ?? email ?? clerkId} provisioned (awaiting dealer assignment)`,
    });
    return created;
  }
  const [raced] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.clerkId, clerkId));
  return raced!;
}

// Test-only bypass for the self-contained validation harness
// (run-gate-cascade-check.sh). Never active in production.
const AUTH_BYPASS =
  process.env.NODE_ENV !== "production" && process.env.AUTH_BYPASS === "1";

const FULL_PERMISSIONS = PERMISSION_MODULES.flatMap((m) =>
  PERMISSION_CATEGORIES.map((c) => ({ module: m, category: c })),
);

async function loadMemberships(userId: number): Promise<DealerMembership[]> {
  const rows = await db
    .select({
      dealerId: dealerUsersTable.dealerId,
      dealerName: dealersTable.name,
      roleId: dealerUsersTable.roleId,
      roleName: rolesTable.name,
      isGeneralManager: dealerUsersTable.isGeneralManager,
    })
    .from(dealerUsersTable)
    .innerJoin(dealersTable, eq(dealerUsersTable.dealerId, dealersTable.id))
    .leftJoin(rolesTable, eq(dealerUsersTable.roleId, rolesTable.id))
    .where(eq(dealerUsersTable.userId, userId))
    .orderBy(dealerUsersTable.dealerId);
  return rows;
}

async function listAllDealers(): Promise<DealerMembership[]> {
  const rows = await db
    .select({ id: dealersTable.id, name: dealersTable.name })
    .from(dealersTable)
    .orderBy(dealersTable.id);
  return rows.map((d) => ({
    dealerId: d.id,
    dealerName: d.name,
    roleId: 0,
    roleName: "Super Admin",
    isGeneralManager: false,
  }));
}

function requestedDealerId(req: Request): number | null {
  const raw = req.header("x-dealer-id");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export const requireAuth: RequestHandler = async (req, res, next) => {
  try {
    if (AUTH_BYPASS) {
      const dealerId = requestedDealerId(req) ?? 2;
      res.locals.user = {
        id: 0,
        clerkId: "test-bypass",
        email: "test@local",
        name: "Test Harness",
        imageUrl: null,
        roleId: null,
        status: "active",
        lastLoginAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: null,
        updatedBy: null,
        roleName: "Test",
        permissions: FULL_PERMISSIONS,
        isSuperAdmin: true,
        dealerId,
        dealers: [],
      } as AuthedUser;
      res.locals.dealerId = dealerId;
      next();
      return;
    }
    const auth = getAuth(req);
    const clerkId = auth?.userId;
    if (!clerkId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const user = await provisionUser(clerkId);
    if (user.status === "suspended") {
      res.status(403).json({ error: "Account suspended" });
      return;
    }

    const isSuperAdmin = isSuperAdminEmail(user.email);
    const dealers = isSuperAdmin
      ? await listAllDealers()
      : await loadMemberships(user.id);

    // Resolve the active dealer: requested header if valid, else the first
    // dealer the user belongs to (or the first dealer overall for super admin).
    const requested = requestedDealerId(req);
    let active: DealerMembership | null = null;
    if (requested != null) {
      active = dealers.find((d) => d.dealerId === requested) ?? null;
      if (!active) {
        res.status(403).json({ error: "Not a member of this dealership" });
        return;
      }
    } else {
      active = dealers[0] ?? null;
    }

    const permissions = isSuperAdmin
      ? FULL_PERMISSIONS
      : await loadPermissions(active?.roleId ?? null);
    const roleName = isSuperAdmin
      ? "Super Admin"
      : (active?.roleName ?? null);

    res.locals.user = {
      ...user,
      roleName,
      permissions,
      isSuperAdmin,
      dealerId: active?.dealerId ?? null,
      dealers,
    };
    if (active) res.locals.dealerId = active.dealerId;
    next();
  } catch (err) {
    next(err);
  }
};

/** Active dealer for the request. Routes behind `authorize` can rely on it. */
export function activeDealerId(res: Response): number {
  const id = res.locals.dealerId;
  if (id == null) throw new Error("No active dealer resolved for request");
  return id;
}

/** Gate for the super-admin-only platform administration endpoints. */
export const requireSuperAdmin: RequestHandler = (_req, res, next) => {
  const user = res.locals.user;
  if (!user?.isSuperAdmin) {
    res.status(403).json({ error: "Super admin only" });
    return;
  }
  next();
};

export function hasPermission(
  user: AuthedUser,
  module: PermissionModule | string,
  category: PermissionCategory | string,
): boolean {
  return user.permissions.some(
    (p) =>
      p.module === module && (p.category === category || p.category === "admin"),
  );
}

type RouteRule = {
  module: string;
  /** Optional override of the default method→category mapping */
  category?: (req: Request) => string;
};

const METHOD_CATEGORY: Record<string, string> = {
  GET: "view",
  POST: "create",
  PATCH: "edit",
  PUT: "edit",
  DELETE: "delete",
};

// Maps the first path segment after /api to a permission module.
const PATH_MODULES: Record<string, RouteRule> = {
  vehicles: { module: "inventory" },
  bookings: { module: "inventory" },
  deliveries: { module: "deliveries" },
  "delivery-advisors": { module: "deliveries" },
  leads: { module: "leads" },
  pipeline: { module: "leads" },
  customers: { module: "customers" },
  deals: { module: "deals" },
  appraisals: { module: "appraisals" },
  "finance-applications": { module: "finance" },
  "finance-connector": { module: "finance" },
  banks: { module: "finance" },
  invoices: { module: "finance" },
  payments: { module: "finance" },
  receipts: { module: "finance" },
  "outstanding-balances": { module: "finance" },
  "service-orders": { module: "service" },
  "service-technicians": { module: "service" },
  "job-cards": { module: "service" },
  "service-invoices": { module: "service" },
  coverage: { module: "service" },
  parts: { module: "parts" },
  suppliers: { module: "parts" },
  "part-purchases": { module: "parts" },
  gates: {
    module: "approvals",
    category: (req) => {
      if (req.method === "GET") return "view";
      const action = (req.body as { action?: string } | undefined)?.action;
      return action === "dismiss" ? "reject" : "approve";
    },
  },
  gra: { module: "gra" },
  dashboard: { module: "dashboard" },
  activity: { module: "dashboard" },
  agents: { module: "dashboard" },
  timeline: { module: "dashboard" },
  admin: {
    module: "settings",
    category: () => "admin",
  },
  "audit-logs": { module: "settings" },
  emails: { module: "settings" },
};

// Signed-in-only paths that carry no specific permission requirement.
// notifications and tasks are per-user features available to every signed-in user.
const AUTH_ONLY_SEGMENTS = new Set([
  "auth",
  "anthropic",
  "copilotkit",
  "notifications",
  "tasks",
  // reports enforce a per-report-type module check inside the route;
  // search filters result groups by the caller's view permissions.
  "reports",
  "search",
  // team member profiles are viewable by every signed-in staff member
  "team",
  // object storage: presigned upload URLs + object serving for any signed-in
  // staff member; feature-level gating (e.g. inventory edit) happens in the UI
  // and on the record mutation that stores the object path.
  "storage",
]);

export function routePermission(
  req: Request,
): { module: string; category: string } | null {
  const segment = req.path.replace(/^\/+/, "").split("/")[0] ?? "";
  if (AUTH_ONLY_SEGMENTS.has(segment)) return null;
  const rule = PATH_MODULES[segment];
  if (!rule) return null;
  const category = rule.category
    ? rule.category(req)
    : (METHOD_CATEGORY[req.method] ?? "view");
  return { module: rule.module, category };
}

export const authorize: RequestHandler = (req, res, next) => {
  const user = res.locals.user;
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const segment = req.path.replace(/^\/+/, "").split("/")[0] ?? "";
  // Platform administration is gated separately (super admin only).
  if (segment === "platform") {
    if (!user.isSuperAdmin) {
      res.status(403).json({ error: "Super admin only" });
      return;
    }
    return next();
  }
  // Without a dealership, only the auth endpoints are reachable — the client
  // shows the "no dealership assigned" screen off /auth/me.
  if (user.dealerId == null && segment !== "auth") {
    res.status(403).json({ error: "No dealership assigned" });
    return;
  }
  const required = routePermission(req);
  if (!required) return next();
  if (!hasPermission(user, required.module, required.category)) {
    res.status(403).json({
      error: `Missing permission: ${required.category} on ${required.module}`,
    });
    return;
  }
  next();
};

const AUDIT_ACTION_BY_CATEGORY: Record<string, string> = {
  create: "create",
  edit: "update",
  delete: "delete",
  approve: "approve",
  reject: "reject",
};

function entityFromPath(req: Request): { type: string | null; id: string | null } {
  const parts = req.path.replace(/^\/+/, "").split("/");
  const type = parts[0] ? parts[0].replace(/s$/, "") : null;
  const id = parts[1] && /^\d+$/.test(parts[1]) ? parts[1] : null;
  return { type, id };
}

/** Records every successful mutating API call to the audit log. */
export const auditTrail: RequestHandler = (req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    return next();
  }
  const segment = req.path.replace(/^\/+/, "").split("/")[0] ?? "";
  if (AUTH_ONLY_SEGMENTS.has(segment)) return next();

  res.on("finish", () => {
    if (res.statusCode < 200 || res.statusCode >= 300) return;
    const user = res.locals.user;
    const required = routePermission(req);
    const module = required?.module ?? segment;
    const category = required?.category ?? "edit";
    const action = AUDIT_ACTION_BY_CATEGORY[category] ?? "update";
    const { type, id } = entityFromPath(req);
    const actorLabel = user?.name ?? user?.email ?? "Unknown user";
    const summary = `${actorLabel} ${action}d ${type ?? "record"}${id ? ` #${id}` : ""}`.replace(
      "updated",
      "updated",
    );

    db.insert(auditLogsTable)
      .values({
        dealerId: res.locals.dealerId ?? null,
        actorUserId: user?.id ?? null,
        actorClerkId: user?.clerkId ?? null,
        actorName: user?.name ?? null,
        actorEmail: user?.email ?? null,
        action:
          action === "approve" || action === "reject"
            ? action
            : action === "create"
              ? "create"
              : action === "delete"
                ? "delete"
                : "update",
        module,
        entityType: type,
        entityId: id,
        summary,
        details: { method: req.method, path: req.path },
        statusCode: res.statusCode,
      })
      .catch((err) => logger.error({ err }, "Failed to write audit log"));
  });
  next();
};
