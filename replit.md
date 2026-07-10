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

Command Center dashboard (KPIs, live orchestration feed, sales-performance chart), Inventory showroom, Journey (agent-orchestration centerpiece), Leads, Deals, Appraisals, Finance, Service, Customers, and a real streaming AI Concierge chat. Red/white, Apple-style glassmorphism, luxury automotive UI with cinematic motion and showroom videos.

- AI agents are INTERNAL orchestration — there is no user-facing "agent fleet" page or `/agents` route. Agent/activity data is reframed as ambient concierge orchestration (Journey page + dashboard feed).
- AI Concierge chat (`/assistant`) is REAL, powered by Anthropic via Replit AI Integrations (no own key; billed to credits). It streams responses and answers with live dealership data injected into the system prompt.
- Showroom videos live in `artifacts/aura/public/videos/` (referenced via `import.meta.env.BASE_URL`).

## User preferences

- Light/bright mode only (NOT dark).
- Strongly car/automotive-themed and aesthetic; use real images.
- No emojis in the UI.
- Keep all features end-to-end.

## Gotchas

- After adding/changing API routes, restart the `artifacts/api-server` workflow — new routes 404 until restart.
- Percentages (`conversionRate`, `successRate`) are already scaled to 0–100; never `* 100` in the UI.
- Access services through the shared proxy at `localhost:80` (e.g. `localhost:80/api/...`), never service ports directly.
- The AI chat send endpoint (`POST /anthropic/conversations/{id}/messages`) is an SSE stream with NO usable generated hook — the client consumes it via `fetch` + `ReadableStream` (buffer partial frames across chunks), not `useSendAnthropicMessage`. The server persists the assistant message in a `finally`/abort path so partials survive client disconnect. (Legacy; the concierge now runs on CopilotKit.)
- The agentic concierge runs on CopilotKit: runtime mounted at `POST /api/copilotkit` (AnthropicAdapter over the Replit Anthropic client), web app wrapped in `<CopilotKit>` with an on-demand `CopilotPopup` (floating launcher, closed by default — an always-open sidebar wasted screen space and clipped the dashboard; keeping it closed also stops suggestion requests from firing on every page load and triggering `ERR_INCOMPLETE_CHUNKED_ENCODING`). The copilotkit route sets `Cache-Control: no-cache, no-transform` + `X-Accel-Buffering: no` (proxy cuts the stream otherwise → `ERR_INCOMPLETE_CHUNKED_ENCODING`), sets `req.url = req.originalUrl`, and is excluded from Express body parsing.
- GRA duty filing (`/gra`): upload an import document image → `POST /gra/extract` (Anthropic vision) autofills a duty draft → `POST /gra/filings` creates a `gra_filing` human decision gate surfaced in Approvals.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
