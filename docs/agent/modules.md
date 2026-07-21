# Domain Modules

## Daily Briefing (`/command-center`) — LEAN by design (2026-07)
- Exactly three sections, nothing else: categorized Triage brief (24h contact SLA; gate reviews deep-link into the lead via `refType`/`refId` in `lib/triage.ts`), Today's Schedule, and a compact Call Sentiment digest (positive/neutral/negative counts + notable negative highlights from `GET /dashboard/sentiment`).
- All charts, KPIs, funnels and analytics were MOVED to Reports. `pages/role-dashboard.tsx` is deleted; every persona lands on `pages/dashboard.tsx`, with triage scoped to their own assignments unless they hold a `BROAD_VIEW_ROLES` manager role.
- Sentiment endpoint: `GET /dashboard/sentiment` — Anthropic reads recent lead notes/messages, 10-min server cache, `?refresh=true` busts it, empty-corpus 200 fallback, 502 + retry button on LLM failure; highlights link to `/lead/:id`.

## Reports (`/reports`) — persona-aware analytics home
- `components/reports/persona-overview.tsx` (client-computed from existing list endpoints, no new data): Advisor persona sees My Performance (own funnel/conversion/response time/delivered revenue); Sales/Service/Finance Managers see Team Performance (pipeline by advisor, 24h SLA compliance, top performers); GM/super-admin adds Leadership View (division performance table Lead→Pre-Book→Delivered, channel performance, sentiment analytics, lost leads).
- BRD Operational Reports for all personas (permission-gated cards): Leads by Source, Quote-to-Order, Avg Response Time, Reservation Conversion (bookings→converted), Pending Invoices.
- Below sits the server-driven "Detailed Reports" engine (`GET /reports`, 10 report types, PDF/Excel/CSV export, `can(module,"view")` gating).

## Inventory (`pages/inventory.tsx`)
- Vehicle click opens `VehicleDetail` dialog: Photo/360° toggle (360 = turntable video) + full spec grid. Staff with inventory create/update permission get "Add Vehicle" (header) and "Edit" (dialog) via `CreateRecordDialog` with shared `vehicleFields()`; edit status options constrained client-side to the same `VEHICLE_STATUS_TRANSITIONS` the server enforces (422 otherwise).
- Photo gallery: `vehicles.images` (jsonb string[]) holds uploaded paths; VehicleDetail shows dedup([imageUrl, ...images]) with thumbnail strip (remove-X only on uploaded entries) and canEdit-gated "Add photos". Uploads: `useUpload` from `@workspace/object-storage-web` → `POST /api/storage/uploads/request-url` presign (image/* only, 10MB cap) → direct GCS PUT → PATCH vehicle `images`. Uploaded `/objects/*` paths render via `/api/storage/objects/*` (`routes/storage.ts`, AUTH_ONLY, no per-object ACL — vehicle display photos only; see TODO in route before reusing for sensitive assets).
- Bulk Excel import: "Import Excel" (same `can("inventory","create")` gate) opens `components/inventory/import-vehicles-dialog.tsx` — styled .xlsx template (`GET /vehicles/import/template`), drag-drop, POST raw multipart fetch with `credentials:"include"` to `/vehicles/import` (no generated hook — multipart binary breaks api-zod codegen; OpenAPI body declared empty `multipart/form-data`). Server (`routes/vehicles.ts`, registered BEFORE `/vehicles/:id`): multer memory 10MB, exceljs, header-alias map, powertrain aliases (electric→EV, gas→Petrol), status normalized, `$`/comma cleanup, per-row Zod validation against `CreateVehicleBody`, 1000-row cap, duplicate-VIN guard (in-file + existing), >10MB → friendly 413; returns `{total,created,failed,errors[{row,message}]}` row-sorted; dialog shows summary + per-row errors, then invalidates the vehicle list.

## Finance (`/finance`)
- 5 tabs: Applications / Banks / Invoices & Payments / Receipts / Outstanding, plus connector pill (LOS name + Live/Sandbox). Insurance is NOT in Finance (it stays a delivery step in `routes/deliveries.ts`).
- Application detail dialog (`components/finance/application-detail.tsx`): status stepper (pending→submitted→under_review→approved/declined→disbursed), Submit-to-Lender / Check-Lender-Status buttons, document upload (raw multipart fetch with `credentials:"include"`), status timeline, LOS log.
- LOS connector abstraction in `lib/los/` — Demerara adapter goes live when `DEMERARA_LOS_API_URL`/`DEMERARA_LOS_API_KEY` set, otherwise deterministic sandbox mock (each sync advances one stage; declines when DTI>45% or no income).
- Status transitions run through `lib/finance-effects.ts`: timeline receipt + lifecycle email + notifications to finance users; declined→`credit_decline` gate; disbursed→deal auto-advances to committed. Payments auto-issue `RCT-` receipts and update invoice status (invoices `INV-YYYY-####`). Lead workflow "Open F&I" links to `/finance?lead=<id>` (prefills + auto-opens the new-application dialog).

## After-sales: Service, Parts, Workshop
- Service page (`pages/service.tsx`): tabs Bookings / Job Cards / Invoices / Warranty & AMC.
- Parts page (`pages/parts.tsx`): tabs Parts / Suppliers / Purchases; low-stock = stock<=reorderLevel; "parts" RBAC module.
- Workshop page (`pages/workshop.tsx`): technician view (`/job-cards?mine=1` matches technicianUserId).
- Job card flow: open→in_progress→quality_check→completed; issuing a part decrements stock (422 on insufficient), returns restock; completed cards roll into a service invoice (parts+labour+15% tax, 409 if one exists; issued→paid/void).
- Reminder emails: `POST /service-orders/{id}/remind` (service_reminder) and `/coverage/{id}/remind` (warranty_reminder) — 422 when the linked customer has no email. `/service-technicians` lists users with the Technician role; technician assignment fires a notification. Tables in `lib/db/src/schema/workshop.ts`.

## AI concierge & agents
- AI agents are INTERNAL orchestration — no user-facing "agent fleet" page or `/agents` route; agent/activity data is ambient concierge orchestration (dashboard feed).
- Concierge runs on CopilotKit: runtime at `POST /api/copilotkit` (AnthropicAdapter over the Replit Anthropic client, billed to credits). Route sets `Cache-Control: no-cache, no-transform` + `X-Accel-Buffering: no` (proxy cuts the stream otherwise → `ERR_INCOMPLETE_CHUNKED_ENCODING`), sets `req.url = req.originalUrl`, and is excluded from Express body parsing.
- Legacy SSE chat (`POST /anthropic/conversations/{id}/messages`): SSE stream with NO usable generated hook — client consumes via `fetch` + `ReadableStream` (buffer partial frames); server persists the assistant message in a `finally`/abort path.

## GRA duty filing (`/gra`)
- Upload an import document image → `POST /gra/extract` (Anthropic vision) autofills a duty draft → `POST /gra/filings` creates a `gra_filing` human decision gate surfaced in Reviews.
