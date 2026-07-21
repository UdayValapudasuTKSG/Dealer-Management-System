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
- Lead/deal stage advances are gated: `POST /leads/{id}/advance` validates requirement checklists (422 `unmet[]`); deal PATCH enforces an allowed-transition map.
- Deals stays OUT of the top nav (deliberate) — reachable via dashboard KPI cards and the copilot `deals` route. Journey + Appraisals pages are deleted; Insurance lives in Delivery, not Finance.
- Sidebar auto-collapses to a 68px icon rail and expands on hover; staged flows use the `CarProgress` order-tracking rail (`components/car-progress.tsx`); AI Agents hub at `/agents` (GET/PATCH `/agents`, `/activity`).
- Dashboard is labeled "Daily Briefing" (route stays `/command-center`); Triage sits FIRST with a 24h contact SLA (`CONTACT_SLA_HOURS` in `lib/triage.ts` — overdue contacts escalate to urgent) and includes assigned test drives, deliveries, and service orders with assignee names.

## User preferences

- LIGHT mode default (2026-07 redesign): soft neutral warm-white canvas (`--background: 40 20% 97%`, sky-blue retired as too strong) + black-and-white glass cards + always-dark left sidebar; DARK mode via Sun/Moon toggle in the sidebar user card (persisted in localStorage). Dark radial body overlay is gated under `.dark body` in index.css.
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
