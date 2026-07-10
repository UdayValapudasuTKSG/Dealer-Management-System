# AURA Dealership OS

AURA is an agentic automotive dealership operating system (DMS): a full-stack web app covering the end-to-end customer journey across inventory, leads, deals, appraisals, finance, service, customers, and a fleet of 12 AI agents, with a live command-center dashboard.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server
- `pnpm --filter @workspace/aura run dev` — run the AURA web app
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Web app: React + Vite + Tailwind (shadcn/ui), recharts for charts
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)

## Where things live

- API contract: `lib/api-spec/openapi.yaml` (source of truth; `info.title` must stay "Api")
- DB schema: `lib/db/src/schema/` (one file per table + barrel `index.ts`)
- API routes: `artifacts/api-server/src/routes/` (one file per domain + barrel `index.ts`)
- Web app: `artifacts/aura/src/` — pages in `src/pages/`, routes wired in `src/App.tsx`
- Generated hooks/schemas: `lib/api-client-react` and `@workspace/api-zod`
- Vehicle images: `artifacts/aura/public/vehicles/` (served at `/vehicles/*.png`, stored as `imageUrl`)

## Architecture decisions

- Contract-first: define endpoints in `openapi.yaml`, run codegen, then implement server routes + client hooks against generated types.
- Dashboard aggregates (summary/pipeline/sales-performance/inventory-breakdown) are computed server-side by fetching tables and reducing in-memory.
- `conversionRate` and agent `successRate` are stored/returned as whole-number percentages (e.g. 14.3, 98.2) — render directly, do NOT multiply by 100.
- `monthlyRevenue` = sum of `otdPrice` for delivered deals created in the current calendar month.
- Service-order `scheduledDate` is a `date({ mode: "string" })` column; Zod coerces incoming date fields to `Date`, so routes convert to `YYYY-MM-DD` strings before insert/update.

## Product

Command Center dashboard (KPIs, live agent feed, sales-performance chart), Inventory, Journey pipeline, Leads, Deals, Appraisals, Finance, Service, Customers, and an AI Agent Fleet (12 agents). Light/bright, automotive-themed UI.

## User preferences

- Light/bright mode only (NOT dark).
- Strongly car/automotive-themed and aesthetic; use real images.
- No emojis in the UI.
- Keep all features end-to-end.

## Gotchas

- After adding/changing API routes, restart the `artifacts/api-server` workflow — new routes 404 until restart.
- Percentages (`conversionRate`, `successRate`) are already scaled to 0–100; never `* 100` in the UI.
- Access services through the shared proxy at `localhost:80` (e.g. `localhost:80/api/...`), never service ports directly.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
