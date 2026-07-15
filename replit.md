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

## Auth & RBAC

- Auth: Replit-managed Clerk (Google SSO + email/password). Landing `/` plus `/sign-in`/`/sign-up` are public; everything else requires sign-in (signed-out → redirect to `/sign-in`, themed dark Clerk card). Web auth is cookie-based (never use setAuthTokenGetter on web).
- JIT provisioning in `artifacts/api-server/src/middlewares/rbac.ts`: first-ever user → General Manager, later users → Sales Advisor. `requireAuth` → `authorize` (path-segment→module, HTTP method→category; POST body `action: "dismiss"` maps to reject) → `auditTrail` (logs every mutating 2xx) wrap all routers except `/healthz`. 15s permission cache with `invalidatePermCache`.
- RBAC data: `roles`/`role_permissions`/`users`/`audit_logs` tables (`lib/db/src/schema/roles.ts` etc.); 11 roles seeded via `pnpm --filter @workspace/scripts run seed-rbac`; 11 modules × 9 categories (`PERMISSION_MODULES`/`PERMISSION_CATEGORIES`); `admin` category implies all.
- Client: `src/lib/auth.tsx` (`AuthProvider`/`useAuthz`/`can`); top-nav clusters filtered by `can(module,"view")`; Settings cluster (Users / Roles & Permissions / Audit Logs at `/settings/*`, guarded by `RequireSettings` in App.tsx with an Access Denied panel); user menu (avatar+role, sign out logs a logout audit event first).
- Test harness bypass: `AUTH_BYPASS=1` (dev-only, never in production) gives a synthetic full-permission user — used by `scripts/run-gate-cascade-check.sh` so the gate-cascades validation keeps passing.

## Product

Cinematic landing/welcome page (`/`, full-bleed showroom video hero, Aston-Martin/BMW-inspired, rendered OUTSIDE the app Shell/sidebar — "Enter Command Center" CTA leads into the app), Command Center dashboard (`/command-center`, viz-forward: trimmed cinematic hero + 4 KPI cards with a revenue sparkline, Revenue Trajectory area chart, Inventory Mix donut (uses `useGetInventoryBreakdown` — powertrain mix), Sales Pipeline funnel with total open value, Units Delivered bar chart (from sales-performance `units`), plus trimmed Decisions/Autonomous-activity panels), Inventory showroom, Journey (agent-orchestration centerpiece), Leads, Deals, Appraisals, Finance, Service, Customers, and a real streaming AI Concierge chat. Blood-red/black, Netflix-inspired dark premium glassmorphism, luxury automotive UI with cinematic motion and showroom videos.

- Theme is DARK by default (blood-red on near-black): tokens live in `artifacts/aura/src/index.css` (bg ~5% lightness, primary `0 82% 44%`; `.glass`/`.glass-panel` dark surfaces, `.glow-red`/`.text-glow` utils; CopilotKit window themed + rounded). Convert page surfaces with the `bg-white/[0.0x]` + `border-white/10` glass convention, NOT hardcoded `bg-white`/`bg-black/*`.
- LIGHT/DARK toggle: `src/hooks/use-theme.ts` (`useTheme`/`initTheme`/`applyTheme`; localStorage key `aura-theme`, default dark) toggles `.light`/`.dark` on `<html>`; `initTheme()` runs in `main.tsx` before render. Sun/Moon button lives at the sidebar bottom. Light tokens are `:root.light {…}` in `index.css` (dark `:root` stays default), plus attribute-selector flips (`:root.light [class~="bg-white/…"]` / `border-white/…`) that convert the dark glass overlays to faint dark overlays on white, and a light CopilotKit theme. In light mode the content `--background` is soft gray (`0 0% 95%`) while the sidebar is solid white, so the two surfaces separate. When adding new pages, use `text-foreground`/`text-muted-foreground` (NOT `text-white`) so they invert in light mode; prefer `bg-foreground/[0.0x]` for hover/surface overlays so they auto-adapt without per-mode overrides.
- TAILWIND v4 GOTCHA: `bg-<name>` / `text-<name>` / `border-<name>` utilities only work if `--color-<name>` is declared in the `@theme inline` block of `index.css`. The `--sidebar*` HSL vars in `:root` were NOT enough — `bg-sidebar` was a silent no-op (transparent) until `--color-sidebar*` were registered in `@theme inline`. See memory `tailwind-v4-theme-tokens.md`.
- Sidebar (`components/layout/sidebar.tsx`): logo is a `<Link href="/">` back to the landing page; brand lockup shows "AURA.OS" + a "Dealership OS" sub; nav is grouped (Intelligence / Sales / Operations / Clients / Compliance), collapsible (`w-64` ↔ `w-[76px]`), with a framer-motion `layoutId="nav-active-indicator"` red bar that slides to the active item; Finance is labelled "F&I". Surface is tokenized (`bg-sidebar`/`border-sidebar-border`) so it renders correctly in both themes.
- Concierge chat is a right-docked in-flow `<CopilotChat>` panel in `components/layout/shell.tsx` (rounded left edge, framer-motion width animation) that PUSHES page content; a floating "Concierge" launcher shows when closed.
- Inventory (`pages/inventory.tsx`): clicking a vehicle opens a `VehicleDetail` dialog with a Photo/360° toggle (360 uses a turntable video) plus a full spec grid.
- Create actions are wired end-to-end via the shared `components/create-record-dialog.tsx` (config-driven form) on Leads, Deals, Customers, Appraisals, Finance, Service — each uses its `useCreateX` hook + `getListXQueryKey()` invalidation + a toast. Coerce select-sourced id fields (e.g. `vehicleId`, `interestedVehicleId`) to `Number` in `onSubmit`. There is no DELETE customer route.
- After-sales suite: Service page (`pages/service.tsx`) is tabbed Bookings / Job Cards / Invoices / Warranty & AMC; Parts page (`pages/parts.tsx`, tabs Parts / Suppliers / Purchases, low-stock = stock<=reorderLevel, "parts" RBAC module); Workshop page (`pages/workshop.tsx`) is the technician view (`/job-cards?mine=1` matches technicianUserId). Job card flow: open→in_progress→quality_check→completed; issuing a part decrements stock (422 on insufficient), returns restock; completed cards roll into a service invoice (parts+labour+15% tax, 409 if one exists; issued→paid/void). Reminder emails: `POST /service-orders/{id}/remind` (service_reminder) and `/coverage/{id}/remind` (warranty_reminder) — 422 when the linked customer has no email. `/service-technicians` lists users with the Technician role; technician assignment fires a notification. Tables live in `lib/db/src/schema/workshop.ts`.
- Pipeline/Journey use dealer-grade phase labels (New Lead / Working / Appointment / Desking / Delivered / Lost) mapped from the `aware/consider/engage/negotiate/won/lost` DB values.

- Navigation is a layered TOP nav bar (`components/layout/top-nav.tsx`), NOT a left sidebar (the old `layout/sidebar.tsx` was deleted; `ui/sidebar.tsx` shadcn primitive is unrelated). Primary row = clustered tabs (Intelligence / Sales / Operations / Clients / Compliance) each with a real image icon from `public/nav/*.png` (`framer-motion` `layoutId="cluster-active"`); clicking a cluster navigates to its first item. Secondary row dynamically shows the active cluster's sub-sections (`layoutId="subnav-active"`), keyed/animated on cluster change. The light/dark toggle (animated Sun/Moon) lives at the top-right of this nav. Active cluster is derived from the current route. Shell is now `flex-col` (TopNav on top, main+concierge row below).
- Routing: `/` is the landing page (no shell); all other pages render inside `<Shell>`. The inner default landing is Pipeline (`/pipeline`), NOT the dashboard — the landing CTA and copilot `home` both point to `/pipeline`. The dashboard lives at `/command-center`. `/pipeline` and `/leads` both render the Pipeline page (`pages/leads.tsx`). Update the top-nav clusters and the copilot ROUTE_MAP/ROUTE_LABEL together if routes change.
- Pipeline (`pages/leads.tsx`, renamed from Leads): NO kanban columns. A clickable stage rail (New Lead→Working→Appointment→Desking→Delivered) with an animated progress line + `layoutId="pipeline-node-active"` node; selecting a stage animates in that stage's lead list (flat rows, not boxes) plus an "AURA recommends" panel that auto-fetches `useGetPipelineSuggestions({ phase })` (agentic AI next-best-actions) with loading/error/retry states.
- Pipeline AI endpoint: `GET /pipeline/suggestions?phase=` (`artifacts/api-server/src/routes/pipeline.ts`, Anthropic via `@workspace/integrations-anthropic-ai`, mirrors gra.ts, returns `{phase,label,count,headline,actions[]}`, 502 on LLM failure). Contract in `openapi.yaml` (`PipelineSuggestions`/`PipelineSuggestionAction`). Restart api-server after route changes.
- Customer detail (`pages/customer-detail.tsx`) shows a read-only "Journey Stage" stepper derived from the client's furthest lead phase and deal stage (deal stages desking/negotiation/finance/committed→Desking, delivered→Delivered).

- AI agents are INTERNAL orchestration — there is no user-facing "agent fleet" page or `/agents` route. Agent/activity data is reframed as ambient concierge orchestration (Journey page + dashboard feed).
- AI Concierge chat (`/assistant`) is REAL, powered by Anthropic via Replit AI Integrations (no own key; billed to credits). It streams responses and answers with live dealership data injected into the system prompt.
- Showroom videos live in `artifacts/aura/public/videos/` (referenced via `import.meta.env.BASE_URL`).

## User preferences

- DARK mode is the DEFAULT (blood-red + black, premium/futuristic, Netflix-inspired), but a LIGHT/white mode toggle is available (Sun/Moon at the sidebar bottom; preference persists in localStorage).
- Strongly car/automotive-themed and aesthetic; use real images.
- No emojis in the UI.
- Keep all features end-to-end — no dead-end clicks.

## Gotchas

- After adding/changing API routes, restart the `artifacts/api-server` workflow — new routes 404 until restart.
- Percentages (`conversionRate`, `successRate`) are already scaled to 0–100; never `* 100` in the UI.
- Access services through the shared proxy at `localhost:80` (e.g. `localhost:80/api/...`), never service ports directly.
- The AI chat send endpoint (`POST /anthropic/conversations/{id}/messages`) is an SSE stream with NO usable generated hook — the client consumes it via `fetch` + `ReadableStream` (buffer partial frames across chunks), not `useSendAnthropicMessage`. The server persists the assistant message in a `finally`/abort path so partials survive client disconnect. (Legacy; the concierge now runs on CopilotKit.)
- The agentic concierge runs on CopilotKit: runtime mounted at `POST /api/copilotkit` (AnthropicAdapter over the Replit Anthropic client), web app wrapped in `<CopilotKit>` with an on-demand `CopilotPopup` (floating launcher, closed by default — an always-open sidebar wasted screen space and clipped the dashboard; keeping it closed also stops suggestion requests from firing on every page load and triggering `ERR_INCOMPLETE_CHUNKED_ENCODING`). The copilotkit route sets `Cache-Control: no-cache, no-transform` + `X-Accel-Buffering: no` (proxy cuts the stream otherwise → `ERR_INCOMPLETE_CHUNKED_ENCODING`), sets `req.url = req.originalUrl`, and is excluded from Express body parsing.
- Lifecycle emails auto-enqueue via `artifacts/api-server/src/lib/email-triggers.ts` (fire-and-forget, never fails the request): lead create → `lead_received`; lead patch advisor change → `lead_assignment`, phase→engage → `test_drive_confirmation`; deal stage → finance/committed/delivered → `finance_processing` / `finance_approved`+`vehicle_booking` / `delivery_confirmation`; service order → completed → `vehicle_ready`. Recipient = lead email or customer email via `customerId`; no email → silently skipped.
- Finance module (`/finance`): 5 tabs — Applications / Banks / Invoices & Payments / Receipts / Outstanding, plus a connector pill (LOS name + Live/Sandbox). Application detail dialog (`components/finance/application-detail.tsx`) has a status stepper (pending→submitted→under_review→approved/declined→disbursed), Submit-to-Lender / Check-Lender-Status buttons, document upload (raw multipart fetch with `credentials:"include"`), status timeline, and LOS log. LOS connector abstraction in `artifacts/api-server/src/lib/los/` — Demerara adapter goes live when `DEMERARA_LOS_API_URL`/`DEMERARA_LOS_API_KEY` are set, otherwise a deterministic sandbox mock (each sync advances one stage; declines when DTI>45% or no income). Status transitions run through `lib/finance-effects.ts`: timeline receipt + lifecycle email + notifications to finance users; declined→`credit_decline` gate; disbursed→deal auto-advances to committed. Payments auto-issue `RCT-` receipts and update invoice status (invoices numbered `INV-YYYY-####`). Lead workflow "Open F&I" links to `/finance?lead=<id>`, which prefills and auto-opens the new-application dialog.
- GRA duty filing (`/gra`): upload an import document image → `POST /gra/extract` (Anthropic vision) autofills a duty draft → `POST /gra/filings` creates a `gra_filing` human decision gate surfaced in Approvals.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
