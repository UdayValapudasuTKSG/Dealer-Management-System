# Platform Console (AURA Realm), Middleware & Dealer Lifecycle

## Realm app (`artifacts/realm/`)
- Standalone super-admin app "AURA Realm" at `/realm/`, styled per the user's "UI Extraction Pack" (`attached_assets/styling-pack/`): quiet-luxury LIGHT-first theme — warm-grey pastel gradient canvas + accent-blobs, white `.glass`/`.glass-strong` cards, dark zinc-950 collapsible sidebar, IBM Plex Serif display + Inter body + JetBrains Mono data, tiny tracked uppercase eyebrows, tabular numerals, teal/emerald accent used sparingly (emerald dot=active, amber=attention, rose=danger), hover-elevate system, small h-3/3.5 lucide icons; own Clerk sign-in.
- Aura's `/admin` page is deleted; `/admin` full-page redirects to `/realm/`; the side-nav "AURA Realm" link is a plain `<a>` (cross-artifact nav must be full-page, never wouter).
- Realm calls `setDealerHeaderEnabled(false)` at boot so a stale `aura-dealer-id` can't 403 platform requests; "Enter Workspace" starts an impersonation grant, sets `aura-dealer-id`, and navigates to aura `/`.
- Realm UI: LifecyclePanel on dealer detail + AgentPoliciesPanel on the network page; "Retry Export" shows on offboarding dealers until `exportUrl` lands.

## Middleware pipeline (2026-07 spec reconciliation, R4.1)
- Order: requireAuth (authn + dealer resolve, stamps `users.lastActiveDealerId`) → authorize (tenant status → RBAC → entitlement) → authedRateLimit → route-level idempotency/validation/scoping.
- Semantics: no active dealer → GET returns 200 `{code:"dealer_selection_required",dealers[]}` (mutation → 400 `dealer_required`); suspended dealer → 423 `tenant_suspended` on writes only (reads pass); unentitled module (dealers.entitlements jsonb: finance→finance_los, gra/service/parts→*_module, agents→ai_agents; missing keys = enabled) → 404 after RBAC; 429 carries `RateLimit-Reset` + `{error:"rate_limited",retryAfter}`.
- Idempotency (`x-idempotency-key`, OPTIONAL, on PATCH /deals/:id, POST /invoices, POST /payments): replay of a completed request returns the stored response (+`Idempotent-Replay: true` header), in-flight duplicate → 409, same key different body → 422 `key_reuse_mismatch`; client aborts release the claim.
- Soft delete (R4.8): DELETE on leads/vehicles sets `deletedAt`/`deletedBy` (never hard-deletes); deleted rows 404 on by-id read/patch and are excluded from lists unless `?includeDeleted=true`; `POST /leads|vehicles/{id}/restore` (delete-class permission) revives them.

## Tenant isolation semantics (2026-07 P0 pass)
- A non-member `x-dealer-id` header → 403 `dealer_forbidden` (client clears the stale header on 403/404); a foreign row id → 404.
- Super-admin dealer binding: a REAL `dealer_users` membership takes precedence — the super admin binds like a normal employee with that ROLE's permissions (never FULL_PERMISSIONS in a workspace; `boundViaMembership` in rbac.ts) and auto-binds a single membership with no header.
- Without a membership, binding requires an unexpired impersonation grant (`POST /platform/impersonation`, reason required, mode `read_only`|`elevated`, TTL 60m): read_only blocks all mutations; elevated still hard-blocks money/comms segments.
- Agent kill switches are platform-reserved: dealer users get 403 `kill_switch_platform_reserved` on status changes (Realm control plane manages them).
- Regression suite: `pnpm --filter @workspace/scripts run verify-p0-security` (fail-closed) must pass after touching rbac/storage/platform routes.

## Dealer lifecycle & governance (2026-07 P3/P4/P5)
- Status machine: provisioning→[active,closed], active→[suspended,offboarding], suspended→[active,offboarding], offboarding→[closed], closed terminal — every hop via POST /platform/dealers/{id}/suspend|resume|offboard|close (illegal jump → 409 `invalid_transition`; PATCH dealer no longer sets status but does set `legalHold`).
- All transitions are ATOMIC compare-and-set (`casDealerStatus` in routes/platform.ts — UPDATE … WHERE status=expected; concurrent loser gets 409).
- Suspend 409s with `blockers[]` (issued/partially_paid invoices, approved-undisbursed finance, pending gates) unless `force:true` (reason min 5 chars).
- Offboard 202s then runs a durable export saga (`lib/dealer-lifecycle.ts`, ledger rows freeze_writes/export_bundle/deliver_export/retention_clock in `provisioning_steps`; 11-table JSON bundle to `${PRIVATE_OBJECT_DIR}/dealers/dealer-{id}/exports/tenant-export.json`; `retentionUntil = offboardedAt + 30d` RETENTION_DAYS); a failed saga is re-driven via POST /platform/dealers/{id}/offboarding/retry (202 only while offboarding, resumes from first non-done step).
- Close is a hard gate: 422 `{unmet:[]}` (export_pending/retention_active/legal_hold/open_gates), NO force.
- Data-plane: closed → 423 `tenant_closed` on ALL requests; suspended/offboarding → 423 writes only.
- Agent policy library: GET/PATCH /platform/agent-policies (agentKey in BODY; `__all__` = global kill switch; unknown key → 422) is super-admin only; `isAgentEnabled` requires dealer active + no disabling `agent_policies` row (missing rows fail open).
- Regression suite: `pnpm --filter @workspace/scripts run verify-isolation-p5` (28 checks; seeds/cleans scratch dealer-1 rows and a scratch dealer) must pass after touching lifecycle/platform/rbac. NOTE: demo dealer 3 is closed.

## Dealer onboarding SAGA (2026-07 P1/P2)
- POST /platform/dealers creates a SHELL (status=provisioning) then drives a durable 10-step saga (`api-server/src/lib/provisioning-saga.ts`, ledger in `provisioning_steps`; ext seams: provision_storage, invite_owner_admin, register_los).
- No DB txn spans external calls — each step is a short claim/record write; retry resumes from the first non-done step, abort compensates in REVERSE (seed_roles never compensated — global) and closes the dealer.
- Activation is gated: POST /platform/dealers/{id}/activate → 422 `{unmet:[]}` until all steps done AND the owner invite is accepted.
- `ownerEmail` on create writes a `dealer_invites` row; Clerk JIT binding (`claimPendingInvites` in rbac.ts, both real-auth and test-user paths) turns the pending invite into a GM membership on first sign-in.
- Dev-only fail injection: `x-provisioning-fail-step` header.
- Regression suite: `pnpm --filter @workspace/scripts run verify-provisioning-saga` (29 checks) must pass after touching saga/platform/rbac.
