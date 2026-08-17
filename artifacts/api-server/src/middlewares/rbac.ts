import type { Request, Response, NextFunction, RequestHandler } from "express";
import { getAuth, clerkClient } from "@clerk/express";
import { eq, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  dealerInvitesTable,
  rolesTable,
  rolePermissionsTable,
  auditLogsTable,
  dealersTable,
  dealerUsersTable,
  impersonationGrantsTable,
  PERMISSION_MODULES,
  PERMISSION_CATEGORIES,
  type User,
  type PermissionModule,
  type PermissionCategory,
  type DealerEntitlements,
  type EntitlementKey,
} from "@workspace/db";
import { and, desc, gt } from "drizzle-orm";
import { logger } from "../lib/logger";

export type DealerMembership = {
  dealerId: number;
  dealerName: string;
  dealerStatus: string;
  entitlements: DealerEntitlements;
  roleId: number;
  roleName: string | null;
  isGeneralManager: boolean;
  usdExchangeRate: number;
  brandName: string | null;
  logoUrl: string | null;
  themeColor: string | null;
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
      /** Set when the bound dealer is suspended: data-plane WRITES are
       * blocked with 423 (reads still served). */
      dealerSuspended?: boolean;
      /** Active dealer lifecycle status (P3): suspended/offboarding block
       * writes (423); closed blocks ALL data-plane access. */
      dealerLifecycleStatus?: string;
      /** Entitlements (feature flags) of the bound dealer — missing keys
       * default to enabled. Backs the entitlement gate (INV-ENT-1). */
      dealerEntitlements?: DealerEntitlements;
      /** Set when a super admin is bound to the dealer via an impersonation
       * grant (NC-10): read_only blocks every mutation; elevated still
       * hard-blocks money-posting, gate resolution, and customer sends. */
      impersonation?: "read_only" | "elevated";
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

/**
 * Clerk JIT invite binding (P2): a pending dealer_invites row whose email
 * matches the signed-in user becomes a real membership on first contact.
 * The founding GM never needs manual roster entry — they just sign in.
 */
async function claimPendingInvites(user: User): Promise<void> {
  if (!user.email) return;
  const invites = await db
    .select()
    .from(dealerInvitesTable)
    .where(
      and(
        sql`lower(${dealerInvitesTable.email}) = ${user.email.toLowerCase()}`,
        eq(dealerInvitesTable.status, "pending"),
      ),
    );
  if (invites.length === 0) return;
  for (const invite of invites) {
    const roleId = await roleIdByName(invite.roleName);
    if (roleId == null) {
      logger.warn(
        { inviteId: invite.id, roleName: invite.roleName },
        "Pending dealer invite references an unknown role; skipping",
      );
      continue;
    }
    if (invite.isGeneralManager) {
      await db
        .update(dealerUsersTable)
        .set({ isGeneralManager: false })
        .where(eq(dealerUsersTable.dealerId, invite.dealerId));
    }
    await db
      .insert(dealerUsersTable)
      .values({
        dealerId: invite.dealerId,
        userId: user.id,
        roleId,
        isGeneralManager: invite.isGeneralManager,
      })
      .onConflictDoUpdate({
        target: [dealerUsersTable.dealerId, dealerUsersTable.userId],
        set: { roleId, isGeneralManager: invite.isGeneralManager },
      });
    await db
      .update(dealerInvitesTable)
      .set({ status: "accepted", acceptedAt: new Date() })
      .where(eq(dealerInvitesTable.id, invite.id));
    await db.insert(auditLogsTable).values({
      dealerId: invite.dealerId,
      actorUserId: user.id,
      actorClerkId: user.clerkId,
      actorName: user.name,
      actorEmail: user.email,
      action: "create",
      module: "settings",
      entityType: "dealer_user",
      entityId: String(user.id),
      summary: `${user.name ?? user.email} accepted the owner-admin invite and joined as ${invite.roleName} (Clerk JIT)`,
      details: { inviteId: invite.id, roleName: invite.roleName },
    });
    logger.info(
      { userId: user.id, dealerId: invite.dealerId },
      "Dealer invite claimed via JIT binding",
    );
  }
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
      dealerStatus: dealersTable.status,
      entitlements: dealersTable.entitlements,
      roleId: dealerUsersTable.roleId,
      roleName: rolesTable.name,
      isGeneralManager: dealerUsersTable.isGeneralManager,
      usdExchangeRate: dealersTable.usdExchangeRate,
      brandName: dealersTable.brandName,
      logoUrl: dealersTable.logoUrl,
      themeColor: dealersTable.themeColor,
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
    .select({
      id: dealersTable.id,
      name: dealersTable.name,
      status: dealersTable.status,
      entitlements: dealersTable.entitlements,
      usdExchangeRate: dealersTable.usdExchangeRate,
      brandName: dealersTable.brandName,
      logoUrl: dealersTable.logoUrl,
      themeColor: dealersTable.themeColor,
    })
    .from(dealersTable)
    .orderBy(dealersTable.id);
  return rows.map((d) => ({
    dealerId: d.id,
    dealerName: d.name,
    dealerStatus: d.status,
    entitlements: d.entitlements,
    roleId: 0,
    roleName: "Super Admin",
    isGeneralManager: false,
    usdExchangeRate: d.usdExchangeRate,
    brandName: d.brandName,
    logoUrl: d.logoUrl,
    themeColor: d.themeColor,
  }));
}

function requestedDealerId(req: Request): number | null {
  const raw = req.header("x-dealer-id");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// Super-admin impersonation grants: a super admin may only bind a dealer's
// workspace (x-dealer-id) while holding an unexpired grant, created via
// POST /platform/impersonation (audited). Cached briefly to avoid a query on
// every request.
type ImpersonationMode = "read_only" | "elevated";
const grantCache = new Map<
  string,
  // expiresAt caps the cache window so a grant is never honored past its
  // actual expiry, even inside the cache TTL (null = no-grant result).
  { mode: ImpersonationMode | null; ts: number; expiresAt: number | null }
>();
const GRANT_CACHE_TTL_MS = 15_000;

export function invalidateGrantCache() {
  grantCache.clear();
}

/** Returns the unexpired grant's mode, or null when no grant exists. When
 * multiple unexpired grants exist, the most recent one wins. */
async function impersonationGrantMode(
  userId: number,
  dealerId: number,
): Promise<ImpersonationMode | null> {
  const key = `${userId}:${dealerId}`;
  const cached = grantCache.get(key);
  const now = Date.now();
  if (
    cached &&
    now - cached.ts < GRANT_CACHE_TTL_MS &&
    (cached.expiresAt === null || now < cached.expiresAt)
  ) {
    return cached.mode;
  }
  const [row] = await db
    .select({
      mode: impersonationGrantsTable.mode,
      expiresAt: impersonationGrantsTable.expiresAt,
    })
    .from(impersonationGrantsTable)
    .where(
      and(
        eq(impersonationGrantsTable.userId, userId),
        eq(impersonationGrantsTable.dealerId, dealerId),
        gt(impersonationGrantsTable.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(impersonationGrantsTable.createdAt))
    .limit(1);
  const mode = (row?.mode as ImpersonationMode | undefined) ?? null;
  grantCache.set(key, {
    mode,
    ts: now,
    expiresAt: row?.expiresAt ? new Date(row.expiresAt).getTime() : null,
  });
  return mode;
}

// Suspicious-access audit rows are deduped per (user, dealer) for a window so
// a stale client header doesn't flood the audit trail on every request.
const suspiciousLogged = new Map<string, number>();
const SUSPICIOUS_DEDUPE_MS = 5 * 60_000;

function auditSuspiciousAccess(user: User, requestedDealer: number, path: string) {
  const key = `${user.id}:${requestedDealer}`;
  const now = Date.now();
  const last = suspiciousLogged.get(key);
  if (last && now - last < SUSPICIOUS_DEDUPE_MS) return;
  suspiciousLogged.set(key, now);
  db.insert(auditLogsTable)
    .values({
      dealerId: null,
      actorUserId: user.id,
      actorClerkId: user.clerkId,
      actorName: user.name,
      actorEmail: user.email,
      action: "access_denied",
      module: "platform",
      entityType: "dealer",
      entityId: String(requestedDealer),
      summary: `${user.name ?? user.email ?? `User #${user.id}`} sent x-dealer-id ${requestedDealer} without a membership (denied with 403)`,
      details: { requestedDealerId: requestedDealer, path },
    })
    .catch((err) => logger.error({ err }, "Failed to write suspicious-access audit row"));
}

/**
 * Resolve the active dealer for a request. Sends the response itself on
 * denial and returns undefined; otherwise returns the membership (or null
 * when no dealer is bound — client shows the picker / console).
 */
async function resolveActiveDealer(
  req: Request,
  res: Response,
  user: User,
  isSuperAdmin: boolean,
  dealers: DealerMembership[],
): Promise<DealerMembership | null | undefined> {
  const requested = requestedDealerId(req);
  if (requested != null) {
    const active = dealers.find((d) => d.dealerId === requested) ?? null;
    if (!active) {
      // NC-1: an x-dealer-id outside the caller's memberships is an
      // authenticated-but-not-permitted condition → 403. (404 is reserved for
      // rows missing WITHIN the active dealer scope.) The attempt is audited
      // for the platform console.
      auditSuspiciousAccess(user, requested, req.path);
      res.status(403).json({ error: "Forbidden", code: "dealer_forbidden" });
      return undefined;
    }
    // Super admins never bind a dealer workspace silently: they need an
    // explicit, audited impersonation grant from the platform console (NC-10).
    // EXCEPTION: a super admin who is ALSO a genuine staff member of the
    // requested dealer (a real dealer_users row) binds via that membership
    // like any other employee — no grant needed, but they get ONLY that
    // role's permissions in the workspace (never platform FULL_PERMISSIONS).
    if (isSuperAdmin) {
      const direct = (await loadMemberships(user.id)).find(
        (d) => d.dealerId === requested,
      );
      if (direct) {
        res.locals.boundViaMembership = true;
        return direct;
      }
      const mode = await impersonationGrantMode(user.id, requested);
      if (!mode) {
        res.status(403).json({
          error: "Impersonation grant required",
          code: "impersonation_required",
        });
        return undefined;
      }
      res.locals.impersonation = mode;
    }
    return active;
  }
  // No header (NC-14): default-dealer resolution is lastActive → sole
  // membership → null (picker payload on GETs / 400 dealer_required on
  // mutations). Super admins resolve against their REAL staff memberships
  // only — never against the all-dealers platform list.
  if (isSuperAdmin) {
    const memberships = await loadMemberships(user.id);
    const resolved = defaultMembership(user, memberships);
    if (resolved) {
      res.locals.boundViaMembership = true;
      return resolved;
    }
    return null;
  }
  return defaultMembership(user, dealers);
}

/** NC-14 default-dealer order: lastActive membership → sole membership. */
function defaultMembership(
  user: User,
  memberships: DealerMembership[],
): DealerMembership | null {
  if (user.lastActiveDealerId != null) {
    const last = memberships.find(
      (d) => d.dealerId === user.lastActiveDealerId,
    );
    if (last) return last;
  }
  return memberships.length === 1 ? memberships[0]! : null;
}

/** Remember the dealer a user last worked in (fire-and-forget, NC-14). */
function stampLastActiveDealer(user: User, dealerId: number): void {
  if (user.lastActiveDealerId === dealerId) return;
  db.update(usersTable)
    .set({ lastActiveDealerId: dealerId })
    .where(eq(usersTable.id, user.id))
    .catch((err) =>
      logger.error({ err }, "Failed to stamp last active dealer"),
    );
}

function isLoopbackRequest(req: Parameters<RequestHandler>[0]): boolean {
  const remoteAddr = req.socket.remoteAddress ?? "";
  return (
    remoteAddr === "::1" ||
    remoteAddr.startsWith("127.") ||
    remoteAddr.startsWith("::ffff:127.")
  );
}

export const requireAuth: RequestHandler = async (req, res, next) => {
  try {
    // Dev-only persona impersonation: outside production, an
    // `x-test-user-email` header signs the request in as that seeded user
    // with their REAL memberships/role/permissions (for persona testing).
    // Loopback-only (traffic arrives via the local reverse proxy), so a
    // misconfigured non-production deployment cannot expose it externally.
    if (process.env.NODE_ENV !== "production" && isLoopbackRequest(req)) {
      const testEmail = req.header("x-test-user-email")?.trim().toLowerCase();
      if (testEmail) {
        const [user] = await db
          .select()
          .from(usersTable)
          .where(eq(usersTable.email, testEmail));
        if (!user) {
          res.status(401).json({ error: `Test user ${testEmail} not found` });
          return;
        }
        const isSuperAdmin = isSuperAdminEmail(user.email);
        if (!isSuperAdmin) await claimPendingInvites(user);
        const dealers = isSuperAdmin
          ? await listAllDealers()
          : await loadMemberships(user.id);
        // Same resolution semantics as the real auth path (opaque 404 on
        // foreign dealers, impersonation grants for super admins, no silent
        // auto-bind) so persona testing exercises production behavior.
        const active = await resolveActiveDealer(
          req,
          res,
          user,
          isSuperAdmin,
          dealers,
        );
        if (active === undefined) return;
        const asPlatform =
          isSuperAdmin && res.locals.boundViaMembership !== true;
        const permissions = asPlatform
          ? FULL_PERMISSIONS
          : await loadPermissions(active?.roleId ?? null);
        res.locals.user = {
          ...user,
          roleName: asPlatform ? "Super Admin" : (active?.roleName ?? null),
          permissions,
          isSuperAdmin,
          dealerId: active?.dealerId ?? null,
          dealers,
        } as AuthedUser;
        if (active) {
          res.locals.dealerId = active.dealerId;
          res.locals.dealerEntitlements = active.entitlements ?? {};
          res.locals.dealerLifecycleStatus = active.dealerStatus;
          if (
            active.dealerStatus === "suspended" ||
            active.dealerStatus === "offboarding"
          )
            res.locals.dealerSuspended = true;
          stampLastActiveDealer(user, active.dealerId);
        }
        next();
        return;
      }
    }
    // Hardened: the harness bypass only ever answers loopback traffic, so a
    // misconfigured non-production deployment cannot expose it to the network.
    if (AUTH_BYPASS && isLoopbackRequest(req)) {
      const dealerId = requestedDealerId(req) ?? 2;
      res.locals.user = {
        id: 0,
        clerkId: "test-bypass",
        email: "test@local",
        name: "Test Harness",
        phone: null,
        imageUrl: null,
        roleId: null,
        status: "active",
        lastLoginAt: null,
        lastActiveDealerId: null,
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
    if (!isSuperAdmin) await claimPendingInvites(user);
    const dealers = isSuperAdmin
      ? await listAllDealers()
      : await loadMemberships(user.id);

    // Resolve the active dealer: requested header if valid; no silent
    // auto-bind for multi-membership users or super admins.
    const active = await resolveActiveDealer(
      req,
      res,
      user,
      isSuperAdmin,
      dealers,
    );
    if (active === undefined) return;

    const asPlatform = isSuperAdmin && res.locals.boundViaMembership !== true;
    const permissions = asPlatform
      ? FULL_PERMISSIONS
      : await loadPermissions(active?.roleId ?? null);
    const roleName = asPlatform
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
    if (active) {
      res.locals.dealerId = active.dealerId;
      res.locals.dealerEntitlements = active.entitlements ?? {};
      res.locals.dealerLifecycleStatus = active.dealerStatus;
      if (
        active.dealerStatus === "suspended" ||
        active.dealerStatus === "offboarding"
      )
        res.locals.dealerSuspended = true;
      stampLastActiveDealer(user, active.dealerId);
    }
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
  // "view" is the master visibility switch for a module: it must be granted
  // explicitly and is NOT implied by "admin". All other categories are still
  // implied by "admin".
  if (category === "view") {
    return user.permissions.some(
      (p) => p.module === module && p.category === "view",
    );
  }
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
  "test-drives": { module: "leads" },
  customers: { module: "customers" },
  reviews: { module: "customers" },
  cases: { module: "customers" },
  deals: { module: "deals" },
  appraisals: { module: "appraisals" },
  "finance-applications": { module: "finance" },
  "finance-connector": { module: "finance" },
  banks: { module: "finance" },
  invoices: { module: "finance" },
  payments: { module: "finance" },
  receipts: { module: "finance" },
  "outstanding-balances": { module: "finance" },
  "service-orders": {
    module: "service",
    category: (req) => {
      // Stage advance must be reachable by Technicians (service:edit, no
      // service:create); the route enforces assigned-technician ownership.
      if (/^\/service-orders\/\d+\/advance\/?$/.test(req.path)) {
        return "edit";
      }
      return METHOD_CATEGORY[req.method] ?? "view";
    },
  },
  "service-technicians": { module: "service" },
  "job-cards": {
    module: "service",
    category: (req) => {
      // Rollover sign-off must be reachable by the assigned Technician, whose
      // role has service:edit but not service:create; the route itself
      // enforces manager-or-assigned-technician identity.
      if (/^\/job-cards\/\d+\/rollover\/approve\/?$/.test(req.path)) {
        return "edit";
      }
      return METHOD_CATEGORY[req.method] ?? "view";
    },
  },
  "service-invoices": { module: "service" },
  coverage: { module: "service" },
  parts: { module: "parts" },
  suppliers: { module: "parts" },
  "part-purchases": { module: "parts" },
  "purchase-orders": { module: "parts" },
  "parts-settings": { module: "parts" },
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
  // Test-drive capacity planning: manager territory under the settings
  // module. Writes map to "edit" (not create/delete) so managers whose role
  // grants settings edit can block/unblock without a create grant.
  "capacity-blocks": {
    module: "settings",
    category: (req) => (req.method === "GET" ? "view" : "edit"),
  },
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
  // divisions are a read-only lookup every signed-in user needs for filters
  "divisions",
  // calendar: derived read-only schedule view — visibility scoping (own vs
  // all) happens inside the route based on the user's role.
  "calendar",
  // object storage: presigned upload URLs + object serving for any signed-in
  // staff member; feature-level gating (e.g. inventory edit) happens in the UI
  // and on the record mutation that stores the object path.
  "storage",
  // documents attach to either a lead or a vehicle — the route enforces the
  // matching module (leads vs inventory) per entity via hasPermission.
  "documents",
  // telephony config + browser-calling tokens: any signed-in staff member may
  // dial; call logging itself is gated on the leads module.
  "telephony",
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

// NC-10: writes that are NEVER permitted under impersonation, even elevated —
// money-posting, gate resolution, and customer-facing sends.
const IMPERSONATION_HARD_BLOCKED_SEGMENTS = new Set([
  "payments",
  "invoices",
  "receipts",
  "outstanding-balances",
  "gates",
  "emails",
  "communications",
  "telephony",
  "enquiries",
]);

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
  const isRead = ["GET", "HEAD", "OPTIONS"].includes(req.method);
  // NC-14: no resolvable active dealer. Data-plane GET → 200 picker payload
  // (never an error); mutation → 400 dealer_required. Exception: roles are
  // GLOBAL reference data the platform console (super admin, no bound
  // dealer) needs to assign dealership members.
  if (user.dealerId == null && segment !== "auth") {
    const globalRolesRead =
      user.isSuperAdmin && req.method === "GET" && req.path === "/admin/roles";
    if (globalRolesRead) return next();
    if (isRead) {
      res.status(200).json({
        code: "dealer_selection_required",
        message: "Select a dealership to continue",
        dealers: user.dealers.map((d) => ({
          id: d.dealerId,
          name: d.dealerName,
        })),
      });
      return;
    }
    res.status(400).json({
      error: "dealer_required",
      message: "No active dealership resolvable for this mutation",
    });
    return;
  }
  // Tenant lifecycle (pipeline stage 3, INV-SUSP-1): suspended/offboarding
  // dealers block data-plane WRITES with 423 while reads are still served
  // (export window). A CLOSED dealer is hard-off — reads AND writes 423.
  // Auth endpoints stay reachable so the client can render the state.
  if (res.locals.dealerLifecycleStatus === "closed" && segment !== "auth") {
    res.status(423).json({
      error: "tenant_closed",
      message: "Dealership is closed — data-plane access is disabled",
    });
    return;
  }
  if (res.locals.dealerSuspended && segment !== "auth" && !isRead) {
    res.status(423).json({
      error:
        res.locals.dealerLifecycleStatus === "offboarding"
          ? "tenant_offboarding"
          : "tenant_suspended",
      message: "Dealership writes are blocked by its lifecycle state",
    });
    return;
  }
  // NC-10 impersonation safety: read-only by default — every mutation is
  // blocked; even an elevated grant hard-blocks money-posting, gate
  // resolution, and customer-facing sends.
  const impersonation = res.locals.impersonation;
  if (
    impersonation &&
    !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
    segment !== "auth"
  ) {
    if (impersonation === "read_only") {
      res.status(403).json({
        error: "Impersonation is read-only; request an elevated grant to write",
        code: "impersonation_read_only",
      });
      return;
    }
    if (IMPERSONATION_HARD_BLOCKED_SEGMENTS.has(segment)) {
      res.status(403).json({
        error:
          "Money-posting, gate resolution, and customer sends are never permitted while impersonating",
        code: "impersonation_blocked",
      });
      return;
    }
  }
  const required = routePermission(req);
  if (required && !hasPermission(user, required.module, required.category)) {
    res.status(403).json({
      error: `Missing permission: ${required.category} on ${required.module}`,
      requiredPermission: `${required.module}:${required.category}`,
    });
    return;
  }
  // Entitlement / feature-flag gate (pipeline stage 5, INV-ENT-1, NC-9):
  // AFTER RBAC. An unentitled module is hidden as 404 — indistinguishable
  // from "does not exist". Missing keys default to enabled.
  const entitlementKey = segmentEntitlement(segment, required?.module);
  if (
    entitlementKey &&
    res.locals.dealerEntitlements?.[entitlementKey] === false
  ) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
};

// Maps a permission module / path segment to the dealer entitlement flag
// that gates it (INV-ENT-1). Modules without a flag are always entitled.
const MODULE_ENTITLEMENTS: Record<string, EntitlementKey> = {
  finance: "finance_los",
  gra: "gra_module",
  service: "service_module",
  parts: "parts_module",
};
function segmentEntitlement(
  segment: string,
  module: string | undefined,
): EntitlementKey | null {
  if (segment === "agents") return "ai_agents";
  if (module && MODULE_ENTITLEMENTS[module]) return MODULE_ENTITLEMENTS[module];
  return null;
}

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
  // Platform routes write their own richer audit rows (platformAudit).
  if (segment === "platform") return next();

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
