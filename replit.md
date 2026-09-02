# AURA Dealership OS

AURA is an agentic automotive dealership operating system (DMS): a full-stack web app covering the end-to-end customer journey across inventory, pipeline, deals, finance, service, parts, and customers, with AI-driven intake agents and a live command-center dashboard. Multi-dealer tenant, RBAC-secured, Clerk-authenticated.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server
- `pnpm --filter @workspace/aura run dev` — run the AURA web app
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Regression suites (run after touching the matching area): `verify-p0-security` (rbac/storage/platform), `verify-isolation-p5` (lifecycle/platform/rbac), `verify-provisioning-saga` (saga/platform/rbac) — all via `pnpm --filter @workspace/scripts run <name>`
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Web: React + Vite + Tailwind v4 (shadcn/ui), recharts; API: Express 5; DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`; API codegen: Orval (from OpenAPI spec)

## Where things live

- API contract: `lib/api-spec/openapi.yaml` (source of truth; `info.title` must stay "Api")
- DB schema: `lib/db/src/schema/` (one file per table + barrel `index.ts`)
- API routes: `artifacts/api-server/src/routes/` (one file per domain + barrel `index.ts`)
- Web app: `artifacts/aura/src/` — pages in `src/pages/`, routes wired in `src/App.tsx`
- Platform console: `artifacts/realm/` — standalone super-admin app "AURA Realm" at `/realm/` (styling, impersonation, lifecycle panels: `docs/agent/platform-realm.md`). Aura's `/admin` full-page redirects to `/realm/`; cross-artifact nav must be a full-page `<a>`, never wouter.
- Generated hooks/schemas: `lib/api-client-react` and `@workspace/api-zod`
- Vehicle images: `artifacts/aura/public/vehicles/`; showroom videos: `artifacts/aura/public/videos/`

## Detailed docs (read the relevant one BEFORE touching that area)

- `docs/agent/auth-rbac.md` — Clerk auth, multi-dealer tenancy rules, RBAC middleware/roles, field-level permissions, seed recovery
- `docs/agent/platform-realm.md` — Realm console, middleware pipeline semantics, tenant isolation (P0), dealer lifecycle/suspend/offboard/close, onboarding saga, agent policy library
- `docs/agent/frontend-conventions.md` — layout/gutters, dark+light theme system, top-nav/routing, view density system
- `docs/agent/pipeline-leads.md` — pipeline rail + stage labels, advance gates, lead detail workbench, lead capture/auto-assign, test-drive booking
- `docs/agent/intake-messaging.md` — lifecycle emails, quote PDFs, Gmail intake agent, WhatsApp bot (Meta + Twilio), Twilio click-to-call, webhooks
- `docs/agent/modules.md` — dashboard, reports, inventory (gallery + Excel import), finance/LOS/payments, service/parts, AI concierge + agent governance, GRA

## Key architecture decisions

- Contract-first: define endpoints in `openapi.yaml`, run codegen, then implement server routes + client hooks against generated types.
- Service customer communications are email-only through each dealership's configured SMTP connection; do not add WhatsApp service reminders or service-status messages.
- MULTI-DEALER TENANCY: active dealer from the `x-dealer-id` header; routes filter EVERY query by it, stamp it on EVERY insert, and 404 cross-dealer ids. Non-member header → 403 `dealer_forbidden`. Details in `docs/agent/auth-rbac.md` + `docs/agent/platform-realm.md`.
- Canonical NC-3 state machines: lead.phase = new → contacted → qualified → proposal → negotiation → won (terminal lost); deal.stage = desking → committed → delivered (terminal cancelled/lost); vehicle.status = available/reserved/sold/delivered (+in_prep etc); delivery = 9-step SAGA; service cases = 7-status machine with adjacent-only transitions (routes/cases.ts). Every lead phase hop is gated one-step via stage checklists (`ADVANCE_TARGET_PHASE` in api-server/src/lib/stage-review.ts); pipeline stage labels are label-only mappings.
- Lead/deal advances are gated: `POST /leads/{id}/advance` validates per-dealer requirement checklists (422 `unmet[]`); deal PATCH enforces an allowed-transition map. AUTO-DESK AGENT: advancing into Negotiation with a vehicle and no linked deal auto-desks a draft deal (kill-switch governed). Deal create is RBAC `deals:create`.
- Vehicle status automation: booking create flips available→reserved (expiry/cancel releases), deal commit→reserved, delivery final step→delivered, deal delivered→sold; `holdUntil` soft-lock 409s bookings. GET /vehicles/:id returns server-computed `priceLines`/`priceTotalWithTax` from dealer_taxes (client never computes tax). Inventory import is an UPSERT by (dealerId, vin) — details in `docs/agent/modules.md`.
- Payments L6: dual invoices (reservation + final), idempotent POST /payments with receipts, bank-financed deals blocked from commit until financing approved. Details in `docs/agent/modules.md`.
- Divisions: dealer-scoped `divisions` table (dealer 1=GT Automotive, dealer 2=CAM Motors); vehicles/leads/deals carry nullable `divisionId`, auto-stamped with the dealer default (`api-server/src/lib/divisions.ts`). `GET /divisions` is auth-only reference data.
- CURRENCY: all stored money amounts are USD-scale; GYD is display-only (`GYD = amount × dealer.usdExchangeRate`, default 209). Web helpers in `artifacts/aura/src/lib/format.ts` (`useMoney()` — GYD primary). Dates render in GMT-4 via `formatGuyanaDate`.
- Vehicle identity validation (input-only): VIN and engine number exactly 17 chars, registration `^[A-Z]{3}[0-9]{1,4}$` (constants in `lib/db/src/schema/vehicles.ts`; enforced in OpenAPI, server, and forms).
- Dashboard is "Daily Briefing" (route `/command-center`) and deliberately LEAN: categorized triage + schedule + sentiment digest only; ALL analytics live in Reports (`/reports`, persona-aware). Details in `docs/agent/modules.md`.
- Pipeline workbench: `/pipeline` is a filterable queue; lead detail is a workbench with ONE advance flow (Action Chain over `GET /leads/{id}/review` + `POST /leads/{id}/advance`). Standalone Tasks and Approvals pages are deleted — pending gates render inline on their records. Details in `docs/agent/pipeline-leads.md`.
- Agent governance: every agent invocation writes an `agent_runs` row; per-dealer kill switches enforced at call sites (platform-reserved to change); governance console at `/agents` (Admin/Leadership). Lead agent brief is deterministic-first with confidence/routing (LLM only phrases text). Details in `docs/agent/modules.md`.
- Dealer-Admin config: field-level permissions per role (server-enforced redaction/403), config-driven Lead Sources, versioned Stage Checklists, per-dealer tax rules, Employee Master — all under Settings. Details in `docs/agent/auth-rbac.md` + `docs/agent/pipeline-leads.md`.
- Deleted/moved pages: Journey, Appraisals, standalone Workshop (merged into Service, `/workshop` redirects), standalone GRA page (embedded in pipeline + delivery), Aura `/admin` (→ `/realm/`). Deals IS in the sidebar (Sales cluster). Insurance lives in Delivery, not Finance.
- Sidebar auto-collapses to a 68px icon rail; staged flows use `CarProgress` (`components/car-progress.tsx`); hero videos live ONLY on the landing page + dashboard (`PageHero` is a compact light header).

## User preferences

- Metallic Bronze theme (2026-07): brand accent is Metallic Bronze #A97142 (`--primary: 27 44% 46%`); blue is fully retired from the UI (kept only in chart SERIES_COLORS). LIGHT mode default: warm ivory canvas with faint bronze radial glows + white glass cards + always-dark sidebar; DARK mode is near-black glass with bronze glows, toggled via Sun/Moon in the sidebar user card (localStorage). `--gold` token = polished bronze highlight. Clerk appearance colors live in `App.tsx` (`clerkAppearance`).
- Strongly car/automotive-themed and aesthetic; use real images. No emojis in the UI.
- Keep all features end-to-end — no dead-end clicks.
- Every build must run the regression + e2e checks before delivery: registered validations `typecheck`, `p0-security`, `isolation-p5`, `provisioning-saga` (plus the `gate-cascades` workflow) must all pass; run targeted e2e/curl tests on any changed endpoints or flows.

## Gotchas

- After adding/changing API routes, restart the `artifacts/api-server` workflow — new routes 404 until restart.
- Drizzle pushes have wiped the `roles`/`role_permissions` tables before (blanket 403s). Recovery steps in `docs/agent/auth-rbac.md`.
- Percentages (`conversionRate`, `successRate`) are already scaled 0–100; never `* 100` in the UI.
- Access services through the shared proxy at `localhost:80` (e.g. `localhost:80/api/...`), never service ports directly.
- Tailwind v4: `bg-<name>`/`text-<name>` utilities silently no-op unless `--color-<name>` is registered in the `@theme inline` block of `index.css`.
- Every editable lead field MUST exist in `LeadUpdate` in openapi.yaml, or Zod strips it server-side and the PATCH 500s ("No values to set"); never cast a generated payload `as never`.
- Multipart binary uploads have NO generated hooks (breaks api-zod codegen) — declare an empty `multipart/form-data` body in OpenAPI and use raw `fetch` with `credentials:"include"`.
- Streaming routes (CopilotKit, SSE) need `Cache-Control: no-cache, no-transform` + `X-Accel-Buffering: no` or the proxy cuts the stream.
- Clerk dev vs production user stores are separate: demo persona accounts exist in DEV only; re-run the seeder against production if needed there.
- `AUTH_BYPASS=1` (dev-only) gives a synthetic super-admin for headless testing; used by the gate-cascades validation.
- Dev persona testing (never in production): open any app URL with `?test-user=<seeded email>` to browse as that user (no Clerk sign-in); `?test-user=off` clears it. Server side, the `x-test-user-email` header does the same for curl. Both only answer loopback traffic (requests via the local proxy qualify).
- Middleware/idempotency/soft-delete semantics, tenant lifecycle 423s, and impersonation rules: `docs/agent/platform-realm.md`. Demo dealer 3 is closed (423s everything).
- Twilio click-to-call silently falls back to the manual flow unless the FULL Voice credential set is present — see `docs/agent/intake-messaging.md`.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
