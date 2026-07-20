# Auth, RBAC & Multi-Dealer Tenancy

## Auth (Clerk)
- Replit-managed Clerk (Google SSO + email/password). Public routes: landing `/`, `/sign-in`, `/sign-up`; everything else requires sign-in (signed-out → redirect to `/sign-in`, themed dark Clerk card). Web auth is cookie-based — never use `setAuthTokenGetter` on web.
- Clerk dev vs production user stores are separate: persona accounts exist in the DEV instance only; re-run the seeder against production after publishing if demo logins are needed there.

## Multi-dealer tenancy
- `dealers` + `dealer_users` membership tables (`lib/db/src/schema/dealers.ts`); every tenant-owned table carries `dealer_id`. GT Automotive (id 1), CAM Motors (id 2 — all pre-tenancy data backfilled here).
- Super admin = `SUPER_ADMIN_EMAIL` env, COMMA-SEPARATED list (currently akhelaaditya99@gmail.com + uday.valapudasu@theksquaregroup.com; code fallback uday.valapudasu@theksquaregroup.com) — may select ANY dealer and use `/platform/*` admin APIs (list/create/update dealers, manage members, list all users). Everyone else must be a `dealer_users` member of the dealer they request.
- Active dealer comes from the `x-dealer-id` header (resolved in `rbac.ts`, exposed via `activeDealerId(res)`). Routes must filter EVERY query by it, stamp it on EVERY insert, and 404 cross-dealer ids.
- `notifyUser`/`notifyUsers`/`enqueueEmail` and timeline/gate/activity inserts all require `dealerId` (take it from the parent record in libs, `activeDealerId(res)` in routes).
- Public flows (enquiries, test-drive booking) derive dealer from the referenced vehicle/lead; Gmail intake + webhooks default to CAM Motors.
- Client: dealer switcher in top nav (static pill for one dealer, dropdown for several; query cache resets on switch); super-admin-only Admin area at `/admin` (`pages/admin.tsx`, guarded by `RequireSuperAdmin`); membership-less users hit the "no dealership assigned" screen (`DealershipGate`).

## RBAC
- JIT provisioning in `artifacts/api-server/src/middlewares/rbac.ts`: first-user-becomes-GM is RETIRED — new users start with NO dealer membership (super admin email is the only special case).
- Middleware chain: `requireAuth` → `authorize` (path-segment→module, HTTP method→category; POST body `action: "dismiss"` maps to reject) → `auditTrail` (logs every mutating 2xx) — wraps all routers except `/healthz`. 15s permission cache with `invalidatePermCache`. Permissions are per-dealer via the membership's role.
- Data: `roles`/`role_permissions`/`users`/`audit_logs` tables (`lib/db/src/schema/roles.ts` etc.); 11 roles seeded via `pnpm --filter @workspace/scripts run seed-rbac`; 11 modules × 9 categories (`PERMISSION_MODULES`/`PERMISSION_CATEGORIES`); `admin` category implies all. "storage" and "team" modules are AUTH_ONLY.
- Client: `src/lib/auth.tsx` (`AuthProvider`/`useAuthz`/`can`); top-nav clusters filtered by `can(module,"view")`; Settings cluster (Users / Roles & Permissions / Audit Logs at `/settings/*`, guarded by `RequireSettings` in App.tsx with an Access Denied panel); user menu (avatar+role, sign out logs a logout audit event first).
- Test harness bypass: `AUTH_BYPASS=1` (dev-only, never in production) gives a synthetic full-permission SUPER-ADMIN user — dealer from `x-dealer-id` header (default 2 / CAM Motors); used by `scripts/run-gate-cascade-check.sh` so the gate-cascades validation keeps passing.

## Seed recovery (roles wiped)
Drizzle schema pushes have wiped `roles`/`role_permissions` more than once (all users end up with NULL role_id → blanket 403s). Fix:
1. `pnpm --filter @workspace/scripts run seed-rbac`
2. `pnpm --filter @workspace/scripts run seed-persona-users` (idempotent; restores user 1 → General Manager, re-creates the 11 demo persona logins, one per role, at `*@aura-demo.com` — credentials in `scripts/src/seed-persona-users.ts` — and creates each persona's CAM Motors `dealer_users` membership, GM + user 1 flagged isGeneralManager).
