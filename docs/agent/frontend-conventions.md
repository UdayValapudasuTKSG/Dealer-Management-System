# Frontend Conventions (aura web app)

## Layout & pages
- Page gutter is UNIFORM: every in-shell page uses full-width `px-5 md:px-8` (matches the top-nav gutter) — via the shared `Page` container (`components/layout/page.tsx`, no max-width/`width` prop) or the same classes on pages with custom containers. Don't reintroduce `max-w-* mx-auto` page wrappers.
- Page headers are COMPACT (nav already names the page): `Page` padding `py-6 md:py-8`, h1 `text-2xl md:text-[1.75rem]` + `text-sm mt-1` subtitle, no kicker/eyebrow rows, list pages `space-y-5`. Pipeline has NO PageHeader — just a command row (view toggle + New Lead). Cinematic heroes (landing, command-center, inventory showroom) are intentionally exempt.

## Theme
- DARK default (blood-red on near-black): tokens in `artifacts/aura/src/index.css` (bg ~5% lightness, primary `0 82% 44%`; `.glass`/`.glass-panel` surfaces, `.glow-red`/`.text-glow` utils; CopilotKit window themed + rounded). Convert page surfaces with the `bg-white/[0.0x]` + `border-white/10` glass convention, NOT hardcoded `bg-white`/`bg-black/*`.
- LIGHT/DARK toggle: `src/hooks/use-theme.ts` (`useTheme`/`initTheme`/`applyTheme`; localStorage key `aura-theme`, default dark) toggles `.light`/`.dark` on `<html>`; `initTheme()` runs in `main.tsx` before render. Toggle button (animated Sun/Moon) is at the top-right of the nav.
- Light tokens are `:root.light {…}` in `index.css`, plus attribute-selector flips (`:root.light [class~="bg-white/…"]` / `border-white/…`, and `text-{emerald,red,amber,sky,orange,slate}-300/400` → 600 shades) that convert dark glass overlays to faint dark overlays on white, and a light CopilotKit theme. These flips are intentionally OUTSIDE any `@layer` block — unlayered CSS beats Tailwind's `@layer utilities`, so they override without `!important`.
- `text-white` is reserved for surfaces that are red/imagery in BOTH themes (bg-primary buttons/pills, text over photos/videos with dark scrims, the dark Clerk card). In light mode the content `--background` is soft gray (`0 0% 95%`).
- New pages: use `text-foreground`/`text-muted-foreground` (NOT `text-white`) so they invert in light mode; prefer `bg-foreground/[0.0x]` for hover/surface overlays so they auto-adapt.
- TAILWIND v4 GOTCHA: `bg-<name>` / `text-<name>` / `border-<name>` utilities only work if `--color-<name>` is declared in the `@theme inline` block of `index.css`; unregistered = silent no-op (transparent).

## Navigation & routing
- Layered TOP nav bar (`components/layout/top-nav.tsx`), NOT a left sidebar (old `layout/sidebar.tsx` deleted; `ui/sidebar.tsx` shadcn primitive is unrelated). Primary row = clustered tabs (Insights & Actions / Sales / Operations / Accounts / Compliance) with real image icons from `public/nav/*.png` (`framer-motion` `layoutId="cluster-active"`); clicking a cluster navigates to its first item. Secondary row shows the active cluster's sub-sections (`layoutId="subnav-active"`). Active cluster derived from current route. Shell is `flex-col` (TopNav on top, main+concierge row below).
- `/` is the landing page (no shell); all other pages render inside `<Shell>`. Inner default landing is Pipeline (`/pipeline`), NOT the dashboard — landing CTA and copilot `home` both point to `/pipeline`. Dashboard lives at `/command-center`. `/pipeline` and `/leads` both render `pages/leads.tsx`.
- Update the top-nav clusters and the copilot ROUTE_MAP/ROUTE_LABEL together if routes change.
- Deals stays OUT of the top nav (deliberate prior decision) but is reachable via dashboard KPI cards and the copilot `deals` route. Appraisals + Journey pages are DELETED (2026-07 revamp).
- Concierge chat is a right-docked in-flow `<CopilotChat>` panel in `components/layout/shell.tsx` (rounded left edge, framer-motion width animation) that PUSHES page content; a floating "Concierge" launcher shows when closed.

## View system (2026-07 revamp)
- `hooks/use-view-mode.ts` (per-page localStorage `aura-view:<key>`, compact default) + `components/view-controls.tsx` ({layout,onLayoutChange,density,onDensityChange}) applied to customers, pipeline, deals (list table + kanban grid), inventory (dense table + compact 4-col grid), finance (applications list table), parts (list table), service (bookings list table). Grid = cards; list = dense table rows; compact is the default density.

## Misc
- Showroom videos: `artifacts/aura/public/videos/` (referenced via `import.meta.env.BASE_URL`).
- Create actions use the shared `components/create-record-dialog.tsx` (config-driven form) with `useCreateX` hook + `getListXQueryKey()` invalidation + toast. Coerce select-sourced id fields (e.g. `vehicleId`, `interestedVehicleId`) to `Number` in `onSubmit`. There is no DELETE customer route.
