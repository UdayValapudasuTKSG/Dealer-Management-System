# DMS — Replit Agent Build Prompts (ordered)

**How to use this file**
1. Upload `DMS_Master_Spec_v3.md` into the Repl so the agent can reference sections.
2. Paste **Prompt 0 (Master Context)** once at project start. It sets rules that apply to *every* later prompt.
3. Then paste **Prompt 1 → 16 in order**. After each, tell the agent: *"Confirm it runs, add RBAC checks on every endpoint, and a happy-path test, before we continue."*
4. Do **not** paste the whole spec at once — feed the referenced section(s) per prompt.

Legend used below: 🟢 build now · 🔴 wait-for-infra (scaffold + stub only; see spec §17).

---

## PROMPT 0 — Master Context & Global Rules (paste ONCE first)

> We are building a **Dealer Management System (DMS)** for CAM Motors & GT Automotive (Guyana). Full spec is in `DMS_Master_Spec_v3.md` in this repo — follow it; when I reference a section (e.g., §7) read that section.
>
> **Stack:** React + Vite + TypeScript + Tailwind + shadcn/ui; Node/Express + TypeScript; PostgreSQL + Drizzle ORM; session auth. File storage via Replit Object Storage. PDFs via a PDF lib. Put all keys in Replit Secrets.
>
> **These global rules apply to EVERYTHING you build from now on — do not violate them:**
> 1. **Multi-tenant:** every record carries `dealerId` (+ `divisionId` where relevant: CAM/GT). Two portals exist — a Super-Admin **Platform Console** (governs dealers) and the **Dealer Workspace** (daily ops). Build the Dealer Workspace; stub Platform Admin as the bridge.
> 2. **RBAC everywhere:** enforce role scope on **every API endpoint and every UI element** (deny by default). Personas: Super Admin, Dealer Admin, Leadership/GM, Sales Manager, Sales Advisor, Delivery Advisor, Service Manager, Service Advisor, Parts Advisor, Technician, Finance Manager, Marketing. Navigation visibility per spec §3.
> 3. **Single source of truth, in-app:** calendar, notifications, call logs, documents, and customer comms live *inside* the app. Email/WhatsApp are outbound reinforcement only. (This is a hard client mandate — §13.)
> 4. **Review-first, not entry-first:** the system/agents pre-fill; the human **reviews → approves/corrects → advances**. Every pipeline stage shows a **Guidance-for-Success checklist with an AI hard-stop** that blocks advancement until mandatory items pass (§6, §7).
> 5. **Reviews are INLINE, never a separate workflow:** a lead shows its pending review/what's-missing **on the lead record at whatever stage it is in** (highlighted banner/badge in context). The sidebar "Reviews" is only a filtered shortcut that deep-links into the lead at its current stage — it is NOT a separate page where work happens.
> 6. **Agents draft, humans approve:** any customer-facing send or state change needs **one-click human approval**; agents never message a customer autonomously.
> 7. **Deterministic core:** pricing, taxes, VIN validation (17 chars), registration pattern (3 letters + 1–4 digits), and round-robin are **plain code, never LLM**. LLMs are only for language/extraction/summarization, with the AI-governance guardrails in §17.3 (grounding, PII minimization, prompt-injection defense on uploaded docs & inbound messages, per-agent kill switch, confidence fallback, audit of every agent run).
> 8. **Everyone lands on their Daily Briefing** (not a list). Dashboards for Advisor / Manager / Leadership are genuinely distinct.
> 9. **WhatsApp-first** for customer messages (email fallback), by customer preference.
> 10. **Never lose history:** interested models, dropped deals, cancellations are retained, never hard-deleted.
> 11. **Localization:** currency GYD + USD (with exchange rate), timezone Guyana (GMT-4).
> 12. **Audit everything:** every user and agent action is written to an immutable Audit Log (who/what/when/before→after).
>
> Acknowledge these rules. Do not build features yet — wait for Prompt 1.

---

## PROMPT 1 — Scaffold, Data Model, Auth, RBAC (🟢)

> Scaffold the app and implement the **full database schema** from spec §9 with Drizzle: Dealer, Division, Showroom, Employee, User(role enum), Lead, LeadInterestedModel, Account, Contact, Asset, Model, Vehicle, Quote(Code), TaxDefinition, Reservation, Payment, Invoice, Activity, Task, TestDrive, Document, CalendarEvent, Notification, Review, ChecklistItem, PipelineStageConfig, SLARule, Case, WorkOrder, WorkOrderLineItem, Part, PriceBook, Warranty, Claim, ServiceCadence, ServiceHistory, Technician, GRAFiling, AgentRun.
> Add validations: VIN & Engine# = 17 chars; Registration = `^[A-Z]{3}[0-9]{1,4}$`; quote quantity = 1. Add global search by last-9 VIN / Registration / Email.
> Implement session auth (hashed passwords), RBAC middleware (deny-by-default), and the app shell with the sidebar from §3 (sections show/hide by role). Seed: 2 divisions (CAM, GT), 6 showrooms, one user per persona.
> Everyone logs in and lands on an (empty for now) **Daily Briefing** route.

## PROMPT 2 — Users, Roles & Permissions, Employee Master, Org, Admin Config (🟢)

> Build spec §2 + Settings: Employee Master (name, role, division, reporting manager, contact); support multiple Sales Managers each owning a subset of advisors. Dealer-Admin config screens: Users, **Roles & Permissions (field-level, configurable — so the client's access matrix can be applied later)**, Lead Sources, Pipeline/Stage + per-stage mandatory-field (checklist) config, Tax config screen (used in Prompt 5), Templates, Email Engine (channel/template config). Audit Logs list view (read). Platform Admin = stub linking to the Super-Admin portal.

## PROMPT 3 — Inventory, Models & Excel Import (🟢)

> Build spec §8.4: Vehicle/InventoryUnit (VIN, Engine#, Manufacturer, Mfg Date [mandatory], Model, Trim, Color, Showroom [tagged], Registration#, applicable tax config, availability: Available/Reserved-TestDrive/Reserved-PreBooked/Sold/Under-Repair). Keep the model simple (no Salesforce-style Product/VehicleDefinition nesting). Stock rolls up by model.
> **Concurrency:** allocation/soft-lock must be race-safe (row lock or optimistic version column) — a VIN can never be double-allocated (§17.1).
> Build a **one-time Excel import tool** (incl. images) with a dry-run + reconciliation report and rollback (§17.7).

## PROMPT 4 — Lead Management + Click-to-Call + Sentiment (🟢)

> Build spec §8.1: lead creation with **mandatory Address** ("Address is required."), combined **Lead Source/Channel** + required social sub-platform when social, **Lead Type** (Individual/Business), **multi-select Interested Models** each with financing (Y/N) + test-drive (Y/N) flags.
> **Dedup (Agent A1):** match name + phone/email against open leads; if match, **append the model(s) to the existing lead**, don't create a duplicate.
> **Round-robin (Agent A2):** on creation, auto-assign a Sales Advisor by **timestamp-based** round robin; manager can override.
> "Lead Owner" is labeled **"Sales Advisor"** everywhere; the accountable owner transfers across stages later.
> **Click-to-call (Agent A6):** call from the lead via a telephony **adapter (stub now, 🟡)**; auto-transcribe → **write ONE Activity** with the **overall call sentiment** (single overall label, not per-line), duration, direction, status, notes; allow manual notes. Call summaries appear as an **Activity on the lead**, never buried in a generic "New Lead" view.

## PROMPT 5 — Quotation ("Code") + Tax Configuration (🟢)

> Build spec §8.2: **auto-generate the Code on lead creation** (Agent A3), before contact, any source, in the **GT exact format** (customer name, **address**, estimate/quote #, **model year [mandatory]**, date sent, vehicle line/trim, color, manufacturer, mfg date; qty always 1; price pulled from inventory — deterministic). A **Generate Code** button is always available; regenerate + resend on any change (color/tax/financing).
> **Tax config (deterministic, per dealer, at vehicle/asset level):** VAT 0%/14% by base model + duty-free above a **configurable threshold** (seed ~20 lakh; EV exclusion configurable); plus GST/Sales/Luxury/Environmental/Registration/Road/Dealer/Documentation. Each tax: name, %/fixed, effective date.

## PROMPT 6 — Accounts, Contacts, Assets & Grouping (🟢)

> Build spec §8.3: Person vs Business Accounts; Contacts under Business Accounts; **manual** household/business grouping (parent/household link). Accounts/Contacts are created/linked at **Pre-Book** (next prompt) and reused for repeat buyers. Delivered vehicles become **Assets** on the Account (lifetime ownership). Build the Account/Contact/Asset screens now; wire the create-at-Pre-Book trigger in Prompt 7.

## PROMPT 7 — Sales Pipeline + Guidance Hard-Stop + INLINE Reviews (🟢)

> Build spec §7 pipeline: New → Contacted → Engaged → Pre-Book → Vehicle Allocated → Payment → Pre-Delivery → Delivered, with the per-stage fields and rules in the §7 table.
> **Guidance for Success (Agent A4):** each stage shows a checklist banner of mandatory items and a **hard stop** blocking advancement until they pass. Configurable per dealer (from Prompt 2).
> **Reviews are INLINE (critical):** on the lead record, at **whatever stage the lead is currently in**, prominently highlight the pending review / what's-missing / who-must-approve — right there in context, NOT on a separate page. Implement the sidebar "Reviews" as a filtered list that **deep-links into the lead at its current stage**, reusing the same inline review UI. Human-in-loop review points: financing exception ("blind eye", manually editable), **cancellation → Sales Manager approval → Finance refund** (retain full history + release vehicle lock), discount-approval (configurable threshold).
> Stage specifics: Contacted requires a **logged call within 24h** (Agent A9 flags breach visually to Advisor + Manager, no external escalation). Test drive only after first contact. Pre-Book requires **reservation fee** → creates/links Account+Contact → sets **Selected Model** (distinct from Interested). Vehicle Allocated: **Agent A11** auto-suggests a VIN unit from Selected Model, validates VIN(17)+Engine#, soft-locks it. "Not Interested" is a first-class close at any point from Contacted→Engaged. Lead cadence: 24h → +3d → +3d → +7d → close with Reason picklist + optional "Revisit in 3 Months".

## PROMPT 8 — Documents + PDF Generation + AI Pre-fill (🟢)

> Build spec §8.10: per-lead/asset Documents (listed types + "Add New"; PDF/JPG/PNG/DOCX ≤20MB; Uploaded By/Date/Version/Comments; **no gov-ID verification**). System-generated **pre-filled PDFs** (code, invoice, handover, warranty) from templates.
> **Agent A5 (doc pre-fill):** on upload, extract fields to pre-fill lead fields (e.g., financing doc → `Financing Qualified`; test-drive date) — treat uploads as untrusted (prompt-injection defense §17.3), pre-fill is **editable, never locked**, and shown as a review the advisor confirms.

## PROMPT 9 — Payments, Dual Invoicing, Finance & GRA (🟢)

> Build spec §8.9 + §8.11: reservation locks Model/Variant/Color/Booking (read-only unless authorized manager). **Two invoice touchpoints** (Agent A12): on reservation payment and on final payment — PDF, send via WhatsApp/Email (adapter stub 🟡), re-sendable, idempotent (§17.6). Capture negotiated final amount (may differ from code). Payment methods: Bank Financing/Cash/Cheque. Refund processing after cancellation approval.
> **Finance section** (Finance Manager scope) + **GRA Filing**: aggregate VAT/duty from invoices, prepare/track GRA returns; Agent A17 drafts, human submits.

## PROMPT 10 — Delivery (🟢)

> Build spec §8.5: Delivery Advisor queue (assigned deliveries). **Agent A13** generates the **pre-filled handover/warranty PDF** to print→sign→scan→upload. Track **Expected** (auto on final payment) vs **Actual** delivery date (manual). Registration = status/checklist only (3rd-party). On Actual date: vehicle becomes an **Asset**, **Agent A14** sends feedback survey within 24h, and ownership **hands off to a Service Advisor**.

## PROMPT 11 — Notifications, Email Engine, WhatsApp + Calendar + Tasks (🟢)

> Build spec §8.12 + §11: **in-app notifications (primary/system-of-record)** for all triggers in §8.12; Email + **WhatsApp adapters (stub 🟡)** as reinforcement; use a **DB-backed outbox with retry/backoff** and webhook signature verification (§17.6).
> **In-app Calendar** (system of record — no Outlook/Teams). **Test-Drive Scheduler (Agent A10):** checks **customer + vehicle** availability (not advisor), soft-locks single-unit models, sends 24h WhatsApp reminder with Yes/No confirm, reschedules on "No".
> **Tasks** page (own scope): assigned/pending/overdue/upcoming; types Call, Follow-up, Test Drive, Document Collection, Reservation Payment, Delivery.
> **Outreach Composer (Agent A7):** from an inline lead review, when info is missing, the agent **drafts the right message on the customer's preferred medium (WhatsApp/Email)** asking for it, and sends **on one-click advisor approval**; log the thread as an Activity.

## PROMPT 12 — Daily Briefing (LEAN — triage + scheduling + call sentiment only) (🟢)

> Build the **Daily Briefing** as each persona's landing page, deliberately **lean**. It shows ONLY:
> 1. **Triage** — what needs action now: leads/tasks due, SLA at risk (24h contact), pending **inline reviews** (deep-link into the lead at its stage), stalled items.
> 2. **Scheduling** — today's calendar: test drives, deliveries, service appointments, calls due.
> 3. **Overall customer call sentiment** — a simple summary of recent calls' overall sentiment (e.g., positive/neutral/negative counts + notable negatives to follow up).
> **Do NOT put charts, KPIs, funnels, conversion rates, or any analytics/visualizations on the Daily Briefing** — those all belong in **Reports** (next prompt). Keep it action-oriented and fast to scan. Scope every item to the persona (Advisor=own, Manager=team, Leadership=both divisions).

## PROMPT 13 — Reports & Persona Dashboards (ALL metrics/viz here) (🟢)

> Build spec §8.12/§15/§3 reporting as the **single home for all metrics and visualizations** (everything excluded from Daily Briefing lives here). Persona-aware:
> - **Sales Advisor:** own pipeline funnel, leads & conversion, follow-ups, SLA snapshot.
> - **Sales Manager:** team pipeline by advisor, SLA compliance, performance, top performers.
> - **Leadership (Vishok/Aditya):** company-wide across **both** divisions — sales, conversion (Lead→Pre-Book→Delivered), revenue by division, channel performance, lost-leads, **detailed call-sentiment analytics**.
> - **Service/Delivery/Finance/Marketing:** their respective report sets from §15.
> Include the specific reports listed in the BRD (Leads by Source, Quote-to-Order, Avg Response Time, Reservation Conversion, Pending Invoices, etc.). All charts/KPIs render here, not on Daily Briefing.

## PROMPT 14 — AI Agents Console + Governance (🟢)

> Build the **AI Agents** section: a console (Admin/Leadership) listing agents A1–A17 (§5) with per-agent **on/off toggle (kill switch, per dealer)**, recent runs, and **acceptance/override + error metrics** (§17.3). Enforce the governance framework across all agents already built: human-approval gates on sends/state-changes, grounding (cite source record), PII minimization, prompt-injection defense on untrusted inputs, confidence-threshold fallback to human, model/version pinning, cost caps, and an AgentRun audit entry per invocation. Operational users see agent activity **inline** on records, not here.

## PROMPT 15 — Service Module (feature-flagged — confirm Phase 1) (🟢, flag default OFF)

> Behind a **feature flag (default OFF)**, build spec §8.6–§8.8: Service Advisor dashboard (assigned Assets), **scheduled** service via configurable **cadences** (km/6-/12-month) with reminders (Agent A15) + free-service count; **unscheduled** service (accident/breakdown). Flow: Case (auto-populated from Asset) → **Service Manager review** → **Work Order** (one active per asset; types PDI/Repair; statuses New→Pending Review→In Progress→On Hold→Completed→Invoice→Closed; Pay Type) → technician availability/Workshop → intake checklist → parts (if needed) → quotation → approval → repair → outtake list → invoice → pickup. Service History on Asset. Warranty/Claim objects (types configurable). Parts: build vehicles-first, parts is Phase 2.

## PROMPT 16 — Enterprise Hardening (build-now items) + Audit (🟢) / stub 🔴

> Apply spec §17 **build-now** items across the app: input validation & rate limiting, secrets via Replit Secrets behind a config layer, idempotency on payment/invoice/allocation, DB-backed outbox + retries, structured logging + app/agent metrics, immutable **Audit Logs** for every user + agent action, effective-dated tax + versioned pipeline/stage config, testing/UAT happy paths per module.
> For **🔴 wait-for-infra** items (uptime SLA/horizontal scale, encryption-at-rest/managed DB, **DR/backup/failover**, managed tracing/alerting, managed message broker): **do NOT build them.** Scaffold the interface/seam, add a `PENDING-INFRA` TODO, and stop — I will provide the infrastructure. Confirm which seams you left for me.

---

### Quick dependency order (why this sequence)
Schema+Auth → Users/Org/Config → Inventory (pricing/allocation source) → Leads → Quote/Tax (needs inventory price) → Accounts (needed at Pre-Book) → **Pipeline + inline reviews** (ties leads↔accounts↔inventory) → Documents → Payments/Finance/GRA → Delivery → Notifications/Calendar/Tasks → **Daily Briefing (lean)** → **Reports (all viz)** → AI Agents console/governance → Service (flagged) → Hardening/Audit.
