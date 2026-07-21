# AURA Dealership OS

AURA is an agentic automotive dealership operating system (DMS): a full-stack web app covering the end-to-end customer journey across inventory, pipeline, deals, finance, service, parts, and customers, with AI-driven intake agents and a live command-center dashboard. Multi-dealer tenant, RBAC-secured, Clerk-authenticated.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server
- `pnpm --filter @workspace/aura run dev` — run the AURA web app
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
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
- Generated hooks/schemas: `lib/api-client-react` and `@workspace/api-zod`
- Vehicle images: `artifacts/aura/public/vehicles/`; showroom videos: `artifacts/aura/public/videos/`

## Detailed docs (read the relevant one before touching that area)

- `docs/agent/auth-rbac.md` — Clerk auth, multi-dealer tenancy rules, RBAC middleware/roles, seed recovery
- `docs/agent/frontend-conventions.md` — layout/gutters, dark+light theme system, top-nav/routing, view density system
- `docs/agent/pipeline-leads.md` — pipeline rail + stage labels, advance gates, lead detail page, lead capture/auto-assign, test-drive booking
- `docs/agent/intake-messaging.md` — lifecycle emails, quote PDFs, Gmail intake agent, WhatsApp bot (Meta + Twilio), webhooks
- `docs/agent/modules.md` — dashboard, inventory (gallery + Excel import), finance/LOS, service/parts/workshop, AI concierge, GRA

## Key architecture decisions

- Contract-first: define endpoints in `openapi.yaml`, run codegen, then implement server routes + client hooks against generated types.
- MULTI-DEALER TENANCY: active dealer from the `x-dealer-id` header; routes filter EVERY query by it, stamp it on EVERY insert, and 404 cross-dealer ids. Details in `docs/agent/auth-rbac.md`.
- Dashboard aggregates are computed server-side (fetch tables, reduce in-memory). `monthlyRevenue` = sum of `otdPrice` for delivered deals created this calendar month.
- Pipeline stage labels (New → Contacted → Engaged → Pre-Book → Vehicle Allocated → Payment → Pre-Delivery → Delivered, per DMS spec) are label-only mappings over lead phase + linked deal stage — NO DB migration.
- Hero videos live ONLY on the landing page + dashboard; `PageHero` is a compact LIGHT header (2026-07: black banner + video removed; `video` prop accepted but ignored). GRA duty filing is reusable via `components/gra/duty-filing.tsx` (X-ray scan animation) and is embedded in the delivery workflow dialog.
- Divisions (Prompt/DMS spec): dealer-scoped `divisions` table (dealer 1=GT Automotive/GT, dealer 2=CAM Motors/CAM); vehicles/leads/deals carry a nullable FK `divisionId`, auto-stamped on create with the dealer's default division (`api-server/src/lib/divisions.ts`). `GET /divisions` is auth-only reference data.
- CURRENCY CONVENTION: all stored money amounts (vehicle price, deal figures, invoices) are USD-scale. GYD is display-only: `GYD = amount x dealer.usdExchangeRate` (default 209, per-dealer on `dealers`). Web helpers in `artifacts/aura/src/lib/format.ts` (`useMoney()` — GYD primary, USD secondary); rate reaches the client via `DealerMembershipInfo.usdExchangeRate`. Dates render in GMT-4 via `formatGuyanaDate`.
- Vehicle identity validation (input-only, not on responses so legacy rows still serialize): VIN and engine number exactly 17 chars, registration `^[A-Z]{3}[0-9]{1,4}$`. Constants in `lib/db/src/schema/vehicles.ts`.
- Lead/deal stage advances are gated: `POST /leads/{id}/advance` validates requirement checklists (422 `unmet[]`); deal PATCH enforces an allowed-transition map.
- Deals stays OUT of the top nav (deliberate) — reachable via dashboard KPI cards and the copilot `deals` route. Journey + Appraisals pages are deleted; Insurance lives in Delivery, not Finance.
- Divisions layer (2026-07): per-dealer `divisions` table (seeded CAM Motors + GT Automotive); `divisionId` on vehicles/leads/deals (deals inherit vehicle's division else dealer default). Money renders GYD-first via `useMoney` in `artifacts/aura/src/lib/format.ts` using per-dealer `usdExchangeRate` (amounts stored in USD); dates render in America/Guyana. VIN/Engine# must be exactly 17 chars; registration must match `^[A-Z]{3}[0-9]{1,4}$` (enforced in OpenAPI, server, and forms).
- Dealer-Admin config (2026-07): field-level permissions per role (hidden/view/edit per field group, enforced server-side — redaction on reads, 403 on blocked PATCH), config-driven Lead Sources (social sources require a sub-platform on capture), versioned per-dealer Stage Checklists feeding the advance gates, per-dealer tax rules, and Employee Master (reporting manager + division on staff). All under Settings (`/settings/sources`, `/settings/stages`, `/settings/taxes`; field access on the Roles page; manager/division on Users). Details in `docs/agent/auth-rbac.md` + `docs/agent/pipeline-leads.md`.
- Sidebar auto-collapses to a 68px icon rail and expands on hover; staged flows use the `CarProgress` order-tracking rail (`components/car-progress.tsx`); AI Agents hub at `/agents` (GET/PATCH `/agents`, `/activity`).
- Dashboard is labeled "Daily Briefing" (route stays `/command-center`); Triage sits FIRST with a 24h contact SLA (`CONTACT_SLA_HOURS` in `lib/triage.ts` — overdue contacts escalate to urgent) and includes assigned test drives, deliveries, and service orders with assignee names. Triage renders as a categorized brief (grouped by Contacts/Approvals/Test Drives/Deliveries/Service/Follow-Ups, capped at 3 per group with "+N more" links) — never a flat dump. Dealership-wide sections (revenue/forecast, sentiment, advisor performance) are gated to manager roles (`BROAD_VIEW_ROLES` in `dashboard.tsx`); most advisor roles get focused dashboards via `role-dashboard.tsx`, and role-less users see a personal fallback. Charts use a mild muted palette (`SERIES_COLORS`, raw hex in recharts), and Units Delivered is a lollipop chart with headline delta per the Income Tracker reference.

## User preferences

- Metallic Bronze theme (2026-07): brand accent is Metallic Bronze #A97142 (`--primary: 27 44% 46%`); blue is fully retired from the UI (kept only in chart SERIES_COLORS). LIGHT mode default: warm ivory canvas with faint bronze radial glows + white glass cards + always-dark sidebar; DARK mode is near-black glass with bronze glows, toggled via Sun/Moon in the sidebar user card (localStorage). `--gold` token = polished bronze highlight, used for brand/status accents (replaces old sky/indigo classes). Clerk appearance colors live in `App.tsx` (`clerkAppearance`).
- Strongly car/automotive-themed and aesthetic; use real images. No emojis in the UI.
- Keep all features end-to-end — no dead-end clicks.

## Gotchas

- After adding/changing API routes, restart the `artifacts/api-server` workflow — new routes 404 until restart.
- Drizzle pushes have wiped the `roles`/`role_permissions` tables before (blanket 403s). Recovery steps in `docs/agent/auth-rbac.md`.
- Percentages (`conversionRate`, `successRate`) are already scaled 0–100; never `* 100` in the UI.
- Access services through the shared proxy at `localhost:80` (e.g. `localhost:80/api/...`), never service ports directly.
- Tailwind v4: `bg-<name>`/`text-<name>` utilities silently no-op unless `--color-<name>` is registered in the `@theme inline` block of `index.css`.
- Every editable lead field MUST exist in `LeadUpdate` in openapi.yaml, or Zod strips it server-side and the PATCH 500s ("No values to set"); never cast a generated payload `as never`.
- Multipart binary uploads have NO generated hooks (breaks api-zod codegen) — declare an empty `multipart/form-data` body in OpenAPI and use raw `fetch` with `credentials:"include"`.
- Streaming routes (CopilotKit, SSE) need `Cache-Control: no-cache, no-transform` + `X-Accel-Buffering: no` or the proxy cuts the stream (`ERR_INCOMPLETE_CHUNKED_ENCODING`).
- Clerk dev vs production user stores are separate: demo persona accounts exist in DEV only; re-run the seeder against production if needed there.
- `AUTH_BYPASS=1` (dev-only) gives a synthetic super-admin for headless testing; used by the gate-cascades validation.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
