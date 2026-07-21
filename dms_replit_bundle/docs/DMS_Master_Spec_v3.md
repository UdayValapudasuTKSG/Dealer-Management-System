# Dealer Management System — Master Functional & Solution Spec (v3.0)

**Client:** CAM Motors & GT Automotive (Guyana) · **Delivered by:** KSquare Solutions
**Supersedes/consolidates:** DMS Functional Specification v2.0, GT Automotives BRD (Oct 2025), and the client review call (20 Jul 2026).
**Purpose of this document:** a single, build-ready specification an implementation team (or Replit/agentic builder) can execute against, and that a client stakeholder can read and approve with confidence.

---

## 0. Executive Summary

The DMS is an **agentic, review-first** platform that runs the entire automotive lifecycle — **Lead → Sale → Delivery → Service** — for multiple dealers (CAM, GT) across multiple divisions and showrooms, replacing Salesforce + Excel + WhatsApp/Outlook.

Three ideas define the product:

1. **Two portals, one platform.** A **Platform Console** (KSquare / Super Admin) onboards and governs dealers; a **Dealer Workspace** (what each dealer's staff use daily) runs operations. Everything is multi-tenant.
2. **Agents do the heavy lifting; humans review.** The persona's core job is *not* data entry — it is to **review what the system/agents prepared, approve or correct it, and advance the stage.** Every stage has an explicit **checklist + review gate**, and an **AI companion enforces a hard stop** until mandatory items are complete.
3. **Single source of truth, in-app first (Vishok's mandate).** Calendar, notifications, calls, documents, and communications all live *inside* the system. WhatsApp/Email are reinforcing outbound channels, not the system of record.

**North-star metric:** *time-to-complete an activity* for the frontline personas (Sales Advisor, Delivery Advisor, Service Advisor). Every screen is designed so a persona can land, see exactly what's missing, act in one or two clicks (often on agent-drafted content), and move on.

---

## Table of Contents
1. Product Architecture — the Two Portals
2. Personas & Org Structure
3. **Navigation → Persona Visibility Matrix** (who sees which section)
4. Design Principles: Lucidity, Speed & Review-First
5. The Agentic Layer — Agents & Automations Catalog
6. Reviews & Checklists Framework (the core operating model)
7. Sales Pipeline — Stages, Fields, Reviews & Gates
8. Module Specs (Lead, Quote/Tax, Accounts, Inventory, Delivery, Service, Parts, Workshop, Finance, GRA, Documents, Notifications)
9. Data Model
10. Integrations Catalog
11. Cross-Cutting: SLAs, Validations, Search, Audit
12. Persona "Golden Paths" (speed design)
13. Vishok's Non-Negotiables (mandatory)
14. Phase 1 / Phase 2 Scope
15. Open Questions & Dependencies
16. Acceptance Criteria
17. **Enterprise Hardening & AI Governance** (+ what Replit builds now vs. waits for infra)
18. **Requirements Traceability Matrix** (proof of alignment)

---

## 1. Product Architecture — the Two Portals

| | **Portal A — Platform Console** | **Portal B — Dealer Workspace** |
|---|---|---|
| **Who** | KSquare Super Admin (platform operator) | Dealer staff (GT, CAM) — all operational personas |
| **Job** | Onboard dealers/tenants, provision divisions & showrooms, cross-tenant config, platform health, billing, global agent policies, feature flags | Run daily operations: leads, sales, delivery, service, finance, compliance |
| **Key sections** | Tenants/Dealers, Global Config, Platform Users, Feature Flags, Cross-tenant Audit, Agent Policy Library | Daily Briefing, Pipeline, Inventory, Deliveries, Service, Parts, Workshop, Finance, Accounts, GRA Filing, Reviews, Tasks, AI Agents, Reports, Settings |
| **Isolation** | Sees all tenants | Scoped to one dealer; a division scopes further (CAM vs GT) |

Everything below (Sections 2–16) is the **Dealer Workspace** unless marked *(Platform)*. The **Platform Admin** item in the sidebar is the bridge from a Super Admin into Portal A.

**Multi-tenancy rules**
- Tenant = Dealer (GT, CAM). Division (CAM / GT brand lines) scopes data within a tenant. **Showroom** (6 locations, e.g., Austin, Dowling) tags every inventory unit.
- Dealer-level configuration (taxes, pipeline stages, templates, lead sources, users, org) lives at **Dealer Admin**. Cross-dealer configuration lives at **Super Admin**. *(Transcript: "these should be at the admin level of a dealer… super admin stuff is something different.")*
- No cross-showroom transfer workflow (out of scope unless requested).

---

## 2. Personas & Org Structure

| Persona | Core responsibility | Reports to |
|--------|---------------------|-----------|
| **Leadership / GM** (Vishok, Aditya) | Company-wide visibility across **both** divisions; approvals only where escalated | — |
| **Sales Manager** | Owns pipeline & SLA compliance for a division; approves cancellations; does **not** manually assign leads | Leadership |
| **Sales Advisor** | Owns lead New→Vehicle Allocated (renamed from "Lead Owner") | Sales Manager |
| **Delivery Advisor** | Physical handover; collect/scan/upload signed docs | Sales/Delivery Manager |
| **Service Advisor** | Owns customer/asset post-delivery; cases, scheduling | Service Manager |
| **Service Manager** | Reviews cases, authorizes work orders, technician allocation | Leadership |
| **Parts Advisor** | Parts availability, ordering, inventory | Service Manager |
| **Technician** | Diagnoses & repairs; updates work orders | Service Manager |
| **Finance Manager** | Payments, refunds, invoicing oversight, GRA filing | Leadership |
| **Marketing** (Manager/Coordinator) | Lead-source & campaign performance | Leadership |
| **Dealer Admin** | Dealer config (taxes, templates, users, org, pipeline) | Super Admin |
| **Super Admin** | Cross-tenant platform administration | — |

- **Employee Master** object holds name, role, division (CAM/GT), reporting manager, contact. Manual maintenance is acceptable in Phase 1 (no HRIS integration). Support **multiple Sales Managers**, each owning a subset of advisors.
- **Ownership transfers with the lifecycle:** the accountable owner moves **Sales Advisor → Delivery Advisor → Service Advisor**. Store *who is currently accountable per stage*, not one fixed person.

---

## 3. Navigation → Persona Visibility Matrix

This maps your sidebar exactly. Scope legend: **Full** = full module · **Own** = only records they own/are assigned · **Team** = their division/reports · **Read** = view-only · **Config** = configure · **—** = hidden.

### INSIGHTS & ACTIONS
| Section | Sales Advisor | Sales Mgr | Delivery Adv | Service Adv | Service Mgr | Finance Mgr | Leadership (Vishok) | Dealer Admin | Super Admin |
|---|---|---|---|---|---|---|---|---|---|
| **Daily Briefing** | Own | Team | Own | Own | Team | Own | Company-wide | Own | Platform |
| **Reports** | Own | Team | Own | Own | Team | Finance | **All, both divisions** | Config | Platform |
| **Reviews** (queue) | Own | Approvals | Own | Own | Case reviews | Refund approvals | Oversight | — | — |
| **Tasks** | Own | Team | Own | Own | Team | Own | Read | — | — |
| **AI Agents** (console) | Inline use | Inline + monitor | Inline use | Inline use | Inline + monitor | Inline use | Monitor | **Config** | **Config (policy)** |

### SALES
| Section | Sales Advisor | Sales Mgr | Delivery Adv | Service Adv | Finance Mgr | Leadership | Dealer Admin |
|---|---|---|---|---|---|---|---|
| **Pipeline** | Own leads | Team (division) | — | — | Read | Read (both) | Read |
| **Finance** | Own lead invoices | Team read | Payment status | — | **Full** | Read (both) | Config taxes |

### OPERATIONS
| Section | Sales Advisor | Sales Mgr | Delivery Adv | Service Adv | Service Mgr | Parts Adv | Technician | Leadership |
|---|---|---|---|---|---|---|---|---|
| **Inventory** | View + allocate | Team | View | View | View | Read | — | Read (both) |
| **Deliveries** | Handoff view | Team | **Full (assigned)** | — | — | — | — | Read |
| **Service** | — | — | — | **Full (assigned)** | Team | Support | Assigned WOs | Read |
| **Parts** | — | — | — | Request/view | Read | **Full** | Consume | Read |
| **Workshop** | — | — | — | Schedule | **Full (bays/WO)** | — | **Assigned jobs** | Read |

### ACCOUNTS · COMPLIANCE · SETTINGS · ADMIN
| Section | Who sees it | Scope |
|---|---|---|
| **Accounts** | Sales Advisor/Mgr (create), Service Adv (their customers), Finance/Leadership (read) | Person & Business accounts, household/business grouping |
| **GRA Filing** *(Compliance)* | **Finance Manager, Dealer Admin, Leadership** | VAT/duty returns, GRA submissions & status |
| **Users** | **Dealer Admin, Super Admin** | Create/manage dealer users |
| **Roles & Permissions** | **Dealer Admin, Super Admin** | Field-level access matrix (see §11) |
| **Audit Logs** | Dealer Admin, Super Admin; Leadership (read) | Immutable action trail |
| **Email Engine** | Dealer Admin, Super Admin | Templates, WhatsApp/email channel config, triggers |
| **Platform Admin** | **Super Admin only** | Bridge to Portal A (tenants, cross-dealer config) |

> **Rule:** enforce on **both API and UI**. The client's detailed persona-to-field access matrix (on their Miro/email) overrides these defaults once received — keep access **configurable**, not hard-coded.

---

## 4. Design Principles — Lucidity, Speed & Review-First

1. **Land on a dashboard, not a list.** Every persona's first screen is their **Daily Briefing** — "here's your day": what's assigned, what's due, what's breaching, what needs review.
2. **Review-first, not entry-first.** The system/agents pre-populate; the persona **reviews & approves**. A lead/record always shows, at a glance: **current stage, what's missing to advance, and which reviews are pending.**
3. **Guidance for Success + hard stop.** Each stage shows a checklist banner of mandatory items. The **AI companion blocks advancement** until they're satisfied (the client explicitly wants a hard stop they don't have today).
4. **One-click, agent-drafted actions.** Calls, messages, quotes, invoices, handover forms — all drafted by agents; the persona confirms and sends.
5. **Single source of truth (in-app).** Calendar, notifications, call logs, documents, comms — inside the system. WhatsApp/Email reinforce outbound only.
6. **WhatsApp-first for customers** (Guyana): customer-facing messages default to WhatsApp with email fallback, by customer preference.
7. **Never lose history.** Multi-model interest, cancellations, dropped models, prior vehicles — all retained even when a deal narrows or dies.

---

## 5. The Agentic Layer — Agents & Automations Catalog

This is the **AI Agents** section and the "heavy lifting" the client asked for ("remove the manual touchpoints," "automate updating of information," "hard stop by AI"). Each agent has a **trigger → action → human-in-loop → output**. All agent actions are logged (Audit Logs) and surfaced as **Activities** on the record.

| # | Agent | Trigger | What it does (heavy lifting) | Human-in-loop |
|---|-------|---------|------------------------------|---------------|
| A1 | **Lead Intake & Dedup Agent** | New lead (any channel) | Normalizes fields; matches name+phone/email against open leads; **appends interested model(s) to existing lead** instead of duplicating; sets Lead Type | Advisor sees merge on the lead |
| A2 | **Round-Robin Assignment Agent** | Lead created | Assigns Sales Advisor by **timestamp-based round robin**; writes assignment timestamp | Manager can override |
| A3 | **Quote/Code Agent** | Lead created / vehicle or tax change | Auto-generates the dealer-specific **Code** (GT exact format) with taxes; regenerates & re-sends on any change | Advisor clicks "send" (WhatsApp/Email) |
| A4 | **Guidance-for-Success Companion (AGUI)** | Any stage advance attempt | Evaluates the stage checklist; **hard-stops** advancement; explains exactly what's missing; offers to fetch it | Advisor completes/approves |
| A5 | **Document Extraction / Pre-fill Agent** | Document uploaded | OCR/extracts fields (e.g., financing doc → `Financing Qualified`; sets test-drive date); pre-fills lead fields | Advisor reviews pre-fill (editable, never locked) |
| A6 | **Call Agent (click-to-call + summary + sentiment)** | Advisor clicks call, or inbound | Places call via telephony integration; **auto-transcribes, summarizes, tags sentiment**; writes a Call **Activity** (start/end/duration/direction/status/recording/notes) | Advisor edits notes |
| A7 | **Outreach Composer Agent** ⭐ | Advisor requests info from a review, or a stage needs customer input | From the review context, **drafts the right message on the customer's preferred medium (WhatsApp/Email)** asking for the missing item, and sends on approval; logs the thread | **One-click advisor approve** before send |
| A8 | **Straight-Through-Processing (STP) Agent** | Simple lead (single model, no test drive) | Advances low-touch leads automatically to the point human judgment is needed | Auto; advisor notified |
| A9 | **SLA Watchdog Agent** | Continuous | Tracks 24h contact SLA & follow-up cadence (24h → +3d → +3d → +7d → close); raises **visual flags** to Advisor + Manager (no external escalation) | Manager visibility |
| A10 | **Test-Drive Scheduler Agent** | Test drive requested (post-contact) | Checks **customer + vehicle** availability, soft-locks single-unit models, sends 24h WhatsApp reminder w/ Yes-No confirm, reschedules on "No" | Advisor confirms slot |
| A11 | **VIN Allocation Agent** | Enter Vehicle Allocated | Auto-suggests VIN unit from **Selected Model**; validates VIN (17) + engine number | Advisor accepts unit |
| A12 | **Invoice Agent** | Reservation paid & final paid | Generates invoice PDF at **both** touchpoints; sends via WhatsApp/Email; supports re-send | Advisor/Finance confirm |
| A13 | **Delivery Doc Agent** | Enter Pre-Delivery | Generates **pre-filled** handover/warranty PDFs from lead/asset data for print-sign-scan | Delivery Advisor prints |
| A14 | **Feedback/Survey Agent** | Actual delivery date set | Sends feedback survey within 24h (WhatsApp/Email); records response | — |
| A15 | **Service Cadence Agent** | Cadence milestone approaching | Notifies customer & Service Advisor; pre-builds the Case draft (mileage/registration prompts) | Service Advisor confirms |
| A16 | **Daily Briefing Agent** | Login / start of day | Composes each persona's prioritized day: assigned work, due tasks, SLA risks, pending reviews | Persona acts |
| A17 | **Finance/GRA Assist Agent** | Invoice/tax events | Aggregates VAT/duty positions; pre-fills **GRA filing** drafts; flags anomalies | Finance approves/submits |

⭐ **A7 determination:** The literal BRD (Oct 2025) does not specify an advisor-facing "ask-the-customer" composer. However, it is **directly justified** by the client's explicit goals — WhatsApp as the primary channel, sending codes/invoices/reminders by preferred medium, and "removing manual touchpoints / decreasing the sales advisor's load." **Recommendation: build it** (with mandatory one-click human approval before any send). It is one of the biggest speed wins for the frontline persona.

**Governance:** Every agent respects RBAC, is toggleable per dealer (Feature Flags, Platform), and every automated send/decision is written to **Audit Logs** and to the record's **Activity** timeline.

---

## 6. Reviews & Checklists Framework (core operating model)

This is the backbone the client cares most about: *"these are all checklists, which is important"* and *"point out the human-in-loop activity… approve."*

**Concepts**
- **Checklist (per stage/sub-stage):** the mandatory + optional items required at that step (fields, documents, payments, confirmations). Rendered as the **Guidance-for-Success banner**. Advancement is **hard-stopped** by Agent A4 until mandatory items pass.
- **Review:** a discrete item in a persona's **Reviews** queue requiring a human decision — *approve / correct / request info / reject*. Reviews are how the "human-in-loop" is made explicit and fast.
- **Document Checklist:** per stage, documents marked **sent / received / pending** (full storage optional; status tracking mandatory).
- **Activity timeline:** every call, message, agent action, and status change is an immutable entry on the record.

**Types of Reviews (human-in-loop points)**
| Review | Owner | Where |
|---|---|---|
| Missing-info review (advance blocked) | Sales/Service Advisor | Any stage gate |
| Financing exception ("blind eye") | Sales Advisor / Manager | Engaged |
| Cancellation approval | Sales Manager | Pre-Book / Payment |
| Refund processing | Finance Manager | After cancellation approval |
| Negotiated-amount / discount approval | Sales Manager (above threshold) | Payment *(configurable; see OQ)* |
| Case review (scope of work) | Service Manager | Service |
| Work-order authorization | Service Manager | Service |
| GRA filing sign-off | Finance Manager | Compliance |

**How a persona experiences it (the golden loop):**
> Land on **Reviews** → open item → agent shows **what's missing + drafted action** → **approve / correct / request-info (A7 sends WhatsApp)** → checklist turns green → **advance**.

---

## 7. Sales Pipeline — Stages, Fields, Reviews & Gates

Everything stays a **Lead** (no separate "Opportunity" object in the UI), but each stage mirrors the Salesforce Lead→Account/Contact/Asset model internally so KSquare and the client "speak the same language."

**Flow:** `New → Contacted (24h SLA) → Engaged → Pre-Book (reservation paid) → Vehicle Allocated (VIN) → Payment (reservation + final) → Pre-Delivery (docs) → Delivered (Closed Won) → Feedback → Handoff to Service`

| Stage | Guidance-for-Success checklist (hard-stop to advance) | Key fields captured | Reviews / agents |
|-------|--------------------------------------------------------|---------------------|------------------|
| **New** | Code generated ✓, Advisor assigned ✓, Address ✓, Lead Source (+social sub) ✓, Interested Model(s) ✓ | Address (mandatory), Lead Source/Channel + sub-platform, Lead Type (Individual/Business), Interested Model(s) w/ financing & test-drive flags | A1 dedup, A2 assign, A3 code |
| **Contacted** | **Call logged within 24h** (blocks advance) | Contacted date, call Activity (summary/sentiment), manual notes | A6 call, A9 SLA flag |
| **Engaged** | Test-drive done/declined ✓ OR quotation sent ✓; financing status set | Preferred variant/color, Financing Qualified (editable), negotiation notes, test-drive record | A5 pre-fill, A7 request-info, A10 test drive; "Not Interested" = first-class close |
| **Pre-Book** *(was "Order Confirmed")* | **Reservation fee paid** ✓ (mandatory), Account+Contact created/linked ✓, **Selected Model** set ✓ | Reservation fee amount/date/mode/receipt #; Selected Model; Account/Contact link | Creates Account/Contact; cancellation → Sales Mgr review |
| **Vehicle Allocated** | VIN (17) ✓ + Engine # ✓ validated; unit soft-locked | VIN, Engine #, Mfg Year, Model, Variant, Color, Allocation date | A11 VIN suggest; inventory soft-lock |
| **Payment** | Final payment method ✓; **invoice generated** ✓ | Reservation & Final payment methods (Bank Financing/Cash/Cheque), negotiated final amount, invoice #/date | A12 invoice; discount review (config) |
| **Pre-Delivery** | Document checklist complete (handover/warranty/insurance/registration status) ✓ | Doc checklist statuses; pre-filled handover PDF; registration status (3rd-party) | A13 doc gen; handoff to Delivery Advisor |
| **Delivered** | **Actual delivery date** ✓ + signed handover uploaded ✓ | Expected delivery date (auto on final payment), Actual delivery date (manual), signed docs | A14 feedback; becomes **Asset**; handoff to Service |

**Lead cadence & closure (from BRD):** Call within 24h → +3 days → +3 days → +7 days → close with **Reason for Lead Closure** (No Response / Unable to Reach / Not Interested / Unqualified / Revisit). Optional **"Revisit Lead in 3 Months"** checkbox.

**Trusted-customer bypass:** `Reservation Fee Paid = No` permitted for trusted customers with a mandatory **Reservation Comment** (reason for bypass).

**Cancellation & refund (from BRD):** Cancel button on Pre-Book & Payment → status *Pending Cancellation* → **Sales Manager approval** → *Approved for Refund* → **Finance** processes refund (bank/cheque), uploads confirmation → *Cancelled – Refunded* → releases vehicle lock, logs activity, **retains full history** (including other interested models). Closed Lost, reason = "Cancelled Reservation."

---

## 8. Module Specifications

### 8.1 Lead Management
Creation (mandatory **Address**; combined **Lead Source/Channel** with social sub-platform; **Lead Type**; **multi-select Interested Models** with per-model financing/test-drive flags). **No qualification gate.** Dedup appends to existing lead. Round-robin auto-assign (timestamp). "Lead Owner" renamed "Sales Advisor" everywhere. Click-to-call + call summary/sentiment as an **Activity** (not buried in the "New Lead" view). Notes/Chatter/Reminders/Tasks enabled on the record.

### 8.2 Quotation ("Code") & Tax Configuration
Code **auto-generated on lead creation**, before contact, any source. **GT exact format**: customer name, **address (must)**, estimate/quote #, **model year (mandatory)**, date sent, vehicle line/trim, color, manufacturer, **manufacturer date (from asset)**; qty always 1; price pre-populated from inventory. **Generate Code always available**; regenerate/resend on any change (color, tax, financing) — quotes go back-and-forth frequently, often needed for **bank financing verification**.
**Tax config (Admin, per dealer, applied at vehicle/asset level):** VAT (0% or 14% by base model), **duty-free** above a threshold (~20 lakh; EVs likely excluded — confirm), plus GST/Sales/Luxury/Environmental/Registration/Road/Dealer/Documentation charges. Each tax: name, %/fixed, effective date. Feeds **GRA Filing** (§8.11).

### 8.3 Accounts, Contacts & Assets
Account/Contact **created at Pre-Book** (lead-convert equivalent); reuse existing account for repeat buyers. **Person Accounts** (individual) vs **Business Accounts** (many Contacts, e.g., police department, PepsiCo). **Household grouping** (family members) — manual by advisor, no auto-match in Phase 1. Delivered vehicle → **Asset** on the Account (lifetime ownership → drives service handoff). Account fields per BRD (General, Contact, Business/Compliance incl. Tax ID/VAT, Vehicle/Brand).

### 8.4 Vehicle Inventory & Asset Management
Vehicle unit: **VIN (exactly 17)**, **Engine # (unique, 1:1 with VIN)**, Manufacturer, **Mfg Date (mandatory)**, Model, Line/Trim, Color, **Showroom (tagged)**, Registration # (later; pattern **3 letters + 1–4 digits**), applicable tax config, **availability** (Available / Reserved-TestDrive / Reserved-PreBooked / Sold / Under Repair). Keep the model simple (avoid Salesforce's Product/VehicleDefinition/Vehicle over-complication — client explicitly asked to simplify). Stock counts roll up by model. **One-time Excel import** (incl. images) — build a migration tool.

### 8.5 Delivery
Delivery Advisor takes pre-filled handover PDF → print → customer inspects/signs → scan → upload. Track **Expected** (auto on final payment) vs **Actual** delivery date (manual). Feedback survey within 24h. Then **handoff to Service Advisor** (within the SLA window — see OQ). Registration handled 3rd-party (status field/checklist only, no integration).

### 8.6 Service (Scheduled & Unscheduled)
*(Feature-flagged — confirm Phase 1 vs 2.)*
- **Introduction call** within 5 business days of delivery; Service Advisor explains cadence.
- **Scheduled:** cadence/milestone-based (km or 6-/12-month; **tweakable per dealer**); reminder → contact → validate mileage/registration/email → check **Service History** → create **Case** → **Service Manager review** → **Work Order** → technician availability → intake checklist → parts (if needed) → quotation → approval → repair → outtake list → invoice → pickup. Configurable **free-service count** (e.g., 3).
- **Unscheduled:** customer-initiated (accident/breakdown); triage on call (close if resolved) → same Case→WO flow.
- **Case fields** (BRD): Case Type (Scheduled/Unscheduled), sub-type (Warranty/Mechanical/Electrical/Collision), Concern/Cause/Correction, Current Mileage, Requested Completion Date, Is-Off-Road, Status (New/Pending Review/Closed). Auto-populate from Asset (Asset #, Contact, Account, Email, VIN, Registration).
- **One active Work Order per asset.** WO types: **PDI**, **Repair**. WO statuses: New → Pending Manager Review → In Progress → On Hold (parts/tech) → Completed → Invoice → Closed. Pay Type: Warranty/Customer Pay/Rectify/Goodwill.
- **Warranty** & **Claim** objects (types TBD — obtain from client). **Service History** on Asset.

### 8.7 Parts *(Phase 2-leaning; complex — client unsure, not even in Excel today)*
Part inventory with statuses (In Stock/Low/Out/On Order/In Transit/Expected/Reserved/Discontinued), types (Spare/Consumable/Accessory), full **costing (USD & GYD)**: unit cost, FOB/CIF, freight (air/ocean), import duty %, VAT %, landed cost, exchange rate, ROQ. Feeds Work Order Line Items and quotations/invoices. **Build vehicles-first; add parts after core sign-off.**

### 8.8 Workshop
Technician-facing: assigned Work Orders, bay/job scheduling, diagnosis (Concern/Cause/Correction), labor hours (estimated/actual), parts consumption, hand-back to Service Advisor. Service Manager sees bay/technician load.

### 8.9 Finance
Reservation locks Model/Variant/Color/Booking (read-only unless authorized manager). **Two invoice touchpoints** (reservation + final), PDF via WhatsApp/Email, re-sendable. Negotiated final amount may differ from code. Refund processing (post cancellation approval). Payment methods: Bank Financing/Cash/Cheque. *(QR/payment-link = nice-to-have pending rails.)* Accounting/ERP (QuickBooks, GL) is **Phase 2**.

### 8.10 Documents & Document Generation
Per-lead/asset Documents: Driving License, Passport, National ID, Utility Bill, Income Proof, Loan Docs, Bank Statement, Registration, Insurance, Warranty, Handover Form, + "Add New." **No gov-ID verification** (checklist convenience only). PDF/JPG/PNG/DOCX ≤20 MB; store Uploaded By/Date/Version/Comments. **System-generated pre-filled PDFs** (code, invoice, handover, warranty) from dealer templates.

### 8.11 GRA Filing *(Compliance)*
Guyana Revenue Authority tax compliance: aggregate VAT/duty from invoices, prepare returns, track submission status, retain audit-ready records. Owner: **Finance Manager / Dealer Admin / Leadership**. Agent A17 drafts filings; human submits.

### 8.12 Notifications, Email Engine & WhatsApp
Triggers (BRD + call): New Lead, Assigned Lead, Upcoming Call (24h SLA), SLA Breach, Test Drive Reminder (24h, Yes/No), Reservation Pending, Invoice Generated, Document Missing, Cancellation → Manager, Approved-for-Refund → Finance, Refund Processed → Customer, Delivery-ready → Delivery team, Delivered → Service queue, Case open → Service Manager, Manager notes → Service Advisor, Feedback survey → Customer, Service Cadence Approaching. Channels: **In-App (primary/system-of-record)**, Email, **WhatsApp (primary customer channel)**. **Email Engine** = template + trigger + channel config (Dealer Admin).

---

## 9. Data Model (consolidated)

Core objects (multi-tenant; carry `dealerId`/`divisionId` where relevant):
**Dealer, Division, Showroom, Employee, User, Lead, LeadInterestedModel, Account, Contact, Asset, Model, Vehicle, Quote(Code), TaxDefinition, Reservation, Payment, Invoice, Activity, Task, TestDrive, Document, CalendarEvent, Notification, Review, ChecklistItem, PipelineStageConfig, SLARule, Case, WorkOrder, WorkOrderLineItem, Part, PriceBook, Warranty, Claim, ServiceCadence, ServiceHistory, Technician, GRAFiling, AgentRun(audit).**

Key validations: VIN & Engine # = 17 chars; Registration = 3 letters + 1–4 digits; quantity on quote = 1; **search by last 9 of VIN, Registration, or Email**. (Field-level detail is inherited from the GT BRD object tables — Lead, Opportunity, Account, Case, Work Order, Part, Price Book.)

---

## 10. Integrations Catalog

| Capability | Provider (suggested) | Phase | Notes |
|---|---|---|---|
| Telephony (click-to-call, recording) | Twilio / Exotel / Knowlarity | 1 | Net-new; adapter + call summary/sentiment (A6) |
| WhatsApp Business | Meta Cloud API / Twilio | 1 | Primary customer channel; templates via Email Engine |
| Email | SendGrid / Resend | 1 | Reinforcing channel |
| PDF generation | in-app (code/invoice/handover/warranty) | 1 | Pre-filled from templates |
| Excel inventory import | in-app (SheetJS) | 1 | One-time migration (incl. images) |
| Document AI/OCR | in-app model | 1 | Pre-fill from uploads (A5); enhancement, non-blocking |
| GRA filing | GRA e-services (if API) else export | 1/2 | Confirm submission channel |
| Accounting/ERP | QuickBooks / ERPNext, GL mapping | **2** | Deferred |
| DocuSign / e-sign | DocuSign | **2** | Current: print-sign-scan |
| Mileage tracking | external system | TBD | Confirm integration vs manual entry |
| HRIS | — | — | Manual Employee Master in Phase 1 |

---

## 11. Cross-Cutting

- **SLAs:** Contact within 24h (visual flag on breach to Advisor + Manager; no external escalation); follow-up cadence 24h/+3d/+3d/+7d; Delivery paperwork immediately post-confirmation; Service intro call within 5 business days; appointment reminder 24h before; Case review immediately on creation; post-delivery service contact (**24h vs 7d — confirm**).
- **RBAC:** field-level, configurable, enforced API+UI; apply client's access matrix when received.
- **Search:** global search by last-9 VIN / Registration / Email across leads, accounts, assets, cases.
- **Audit Logs:** immutable trail of every user + agent action (who/what/when/before-after).
- **History retention:** interested models, cancellations, dropped deals never deleted.

---

## 12. Persona Golden Paths (speed design)

*Objective: minimize clicks/time to complete an activity.*

- **Sales Advisor — advance a lead:** Login → Daily Briefing shows "3 leads need action" → open lead → **Guidance banner** shows the one missing item → agent has drafted the WhatsApp to request it → **approve & send (1 click)** → when reply lands, field auto-fills (A5) → **Advance**. *Target: <60 sec of human time per touch.*
- **Sales Advisor — first contact:** Briefing "Call due (SLA 4h left)" → **click-to-call** → talk → **call summary + sentiment auto-written** → stage auto-moves New→Contacted. *Target: no manual note typing required.*
- **Delivery Advisor — handover:** Briefing "2 deliveries today" → open → **handover PDF already pre-filled** → print → after signing, **upload scan** → set Actual Delivery Date → done (Asset + feedback auto-fire). *Target: 2 clicks + upload.*
- **Service Advisor — cadence intake:** Briefing "cadence due" → Case **draft pre-built** (mileage/registration prompts) → confirm with customer via A7 → submit for Manager review. *Target: review, don't retype.*

---

## 13. Vishok's Non-Negotiables (MANDATORY)

These must be demonstrably true in any demo/hand-off:
1. **Single source of truth — everything in-system.** Calendar, notifications, calls, documents, comms live in the DMS. **No dependency on Outlook/Teams/external email** for the workflow. *(Direct quote: "Vishok is more interested in getting everything within the system… single source of truth.")*
2. **Distinct company-wide Leadership dashboard across BOTH divisions** (CAM + GT) — not an aggregate of advisor views; genuinely its own executive lens.
3. **In-app calendar & scheduling** as the system of record (WhatsApp/Email only reinforce).
4. **AI companion with hard stops** (Guidance for Success) enforcing checklists at every stage.
5. **Review-first experience** so leadership sees status, SLA compliance, and bottlenecks at a glance, without chasing people.
6. **KT/communication trail:** everything auditable in-system (supports the "send Aditya a mail that KT is done and the team is building" expectation — the *system* is the record).

---

## 14. Phase 1 / Phase 2 Scope

**Phase 1 (now):** Two-portal foundation; Lead→Delivery pipeline; Quote/Tax; Accounts/Contacts/Assets; Inventory (+Excel import); Documents & generation; Payments & dual invoicing + Finance basics; Notifications/Email Engine/WhatsApp; Reviews/Checklists/Guidance hard-stop; Daily Briefing; persona dashboards & reports; RBAC/Audit; **Agents A1–A14, A16, A17**; GRA Filing (basic). **Service (§8.6) = feature-flagged; confirm.**

**Phase 2:** Parts inventory & pricing (complex); Accounting/ERP (QuickBooks, GL); Customer self-service portal; DocuSign e-sign; HRIS sync; advanced mileage integration.

**Out of scope:** 3rd-party registration/insurance processing (status/checklist only); cross-showroom transfer.

---

## 15. Open Questions & Dependencies (confirm with Sheri / Faraz / Marlisa / Vishok / Aditya)
1. **Service (§8.6) Phase 1 or 2?** — build feature-flagged, default off.
2. **Duty-free threshold & excluded vehicle types (EVs?)** — configurable; seed ~20 lakh, VAT 0/14%.
3. **Round-robin re-balancing** after initial assignment? — default sticky + manager override.
4. **Persona-to-field access matrix** (on Miro/email) — apply on receipt.
5. **Discount/negotiation approval matrix** — configurable threshold, default off.
6. **Warranty types & terms** — from BRD/Miro.
7. **Service contact SLA** — 24h vs 7d.
8. **Mileage tracking** — external integration vs manual.
9. **Invoice/handover templates & feedback form** — obtain client formats.
10. **Full ~80-page BRD + Miro board** — cross-check Lead/Account/Delivery/Service.

---

## 16. Acceptance Criteria

- [ ] Two portals exist: Platform Console (Super Admin) governs dealers; Dealer Workspace runs ops.
- [ ] Every persona lands on their **Daily Briefing**; dashboards for Advisor / Manager / **Leadership (both divisions)** are genuinely distinct.
- [ ] **Navigation visibility** matches §3 per persona (enforced API + UI).
- [ ] Address mandatory; combined Lead Source (+social sub) captured & reported.
- [ ] Multiple Interested Models with per-model financing/test-drive flags; duplicates append, never duplicate.
- [ ] Timestamp round-robin auto-assign; no qualification gate; "Lead Owner"→"Sales Advisor" everywhere; ownership transfers Sales→Delivery→Service.
- [ ] Code auto-generated on creation in GT exact format; Manufacturing Year mandatory; regenerate/resend anytime.
- [ ] Taxes (VAT + duty-free) configurable per dealer at vehicle/asset level; feed GRA Filing.
- [ ] **Every stage has a checklist + hard-stop** (AI companion) blocking advance until mandatory items pass.
- [ ] **Reviews queue** works with approve/correct/request-info; human-in-loop points (cancellation, refund, case, discount) enforced.
- [ ] Click-to-call logs a call Activity with summary/sentiment.
- [ ] **Outreach Composer (A7):** from a review, agent drafts a WhatsApp/Email on the customer's preferred medium and sends on one-click approval; thread logged.
- [ ] Test-drive scheduling checks customer + vehicle availability, only post-contact; 24h WhatsApp confirm.
- [ ] Reservation fee locks Model/Variant/Color and creates/links Account + Contact; Selected Model set only after fee.
- [ ] VIN (17) + Engine # validated at allocation; VIN auto-suggested from Selected Model.
- [ ] Invoices at reservation and final; re-sendable via WhatsApp/Email.
- [ ] Expected vs Actual delivery dates tracked; delivered vehicle becomes an Asset; feedback within 24h; handoff to Service.
- [ ] Documents uploaded without gov-ID verification; handover forms pre-filled from lead data.
- [ ] Service (if enabled): Case → Manager review → Work Order (one active per asset) → parts/labor → invoice → outtake; cadence reminders.
- [ ] **Single source of truth:** calendar, notifications, comms, documents all in-app (Vishok mandate).
- [ ] Audit Logs capture every user and agent action.

---

## 17. Enterprise Hardening & AI Governance

This section is what elevates the spec from an excellent *functional* design to an *industry-grade enterprise* one. It defines the non-functional, security, AI-governance, and operational spine.

### 17.0 Build guidance for Replit (read first)
Each requirement is tagged so the builder knows what to do **now** vs. later:

- 🟢 **BUILD NOW** — app-level, fully within Replit's capability; part of Phase 1.
- 🟡 **SEAM NOW / WIRE LATER** — build the interface/abstraction now; connect the real provider when available.
- 🔴 **WAIT FOR INFRA** — depends on infrastructure the client (Akhelaaditya) will provision. **Do NOT block Phase 1.** Build the code seam, leave a clearly-marked TODO, and pause the actual wiring until the infra is provided.

> **Instruction to the builder:** Implement all 🟢 items in Phase 1. For 🟡, define the abstraction (adapter/interface) and a working local/default implementation. For 🔴, **stop and wait** — scaffold the interface and a no-op/stub, log a `PENDING-INFRA` marker, and do not attempt to stand up the infrastructure yourself.

### 17.1 Non-Functional Requirements (NFRs)
| Requirement | Target | Tag |
|---|---|---|
| Lead intake throughput | Sustain the social peak (200–500 leads/day) + other channels; async intake, paginated lists, indexed search | 🟢 |
| Interactive latency | Core screens < 1.5s p95; agent-drafted content < 5s p95 | 🟢 |
| Inventory concurrency | Soft-lock / allocation must be race-safe — DB row locks or optimistic concurrency (version column); no double-allocation of a VIN | 🟢 |
| Availability / uptime SLA | Formal uptime target (e.g., 99.9%) | 🔴 (depends on hosting infra) |
| Horizontal scale / load balancing | Multi-instance behind LB | 🔴 |

### 17.2 Security & Data Protection
| Control | Approach | Tag |
|---|---|---|
| AuthN | Session-based email/password (or Replit Auth); password hashing (bcrypt/argon2); optional MFA seam | 🟢 |
| AuthZ / RBAC | Field-level, configurable, enforced on **every API endpoint** and UI; deny-by-default | 🟢 |
| Input validation & output encoding | Validate all inputs (VIN/reg patterns, file types/size ≤20MB); prevent XSS/SQLi (ORM/parameterized) | 🟢 |
| Rate limiting & abuse control | Per-user/IP limits; throttle inbound WhatsApp/webhooks | 🟢 |
| Encryption in transit | TLS everywhere | 🟡 (cert via host) |
| Encryption at rest | Managed-DB / disk encryption; encrypt sensitive columns | 🔴 (managed infra) |
| Secrets management | Use **Replit Secrets** now; abstract behind a config layer to move to a vault later | 🟡 |
| PII handling | Classify PII (name, phone, email, bank docs); least-privilege access; redaction in logs; retention policy | 🟢 |
| Data-protection compliance (Guyana) | Consent/retention/classification model; confirm local data-protection obligations | 🟡 (policy input needed) |

### 17.3 AI Governance Framework (applies to every agent in §5)
The agentic layer is the futuristic differentiator — and the highest-risk surface. All 🟢 (build now); they are non-negotiable for putting agents in front of customers.

| Guardrail | Requirement |
|---|---|
| **Human-in-loop gates** | Any customer-facing send (A7 outreach, A12 invoice, A3 code) or state change requires explicit human approval; agents never message a customer autonomously. |
| **Grounding / no hallucination** | Agents act only on record data; generated content (quotes, messages, summaries) must cite the source record/fields; no fabricated values. |
| **Prompt-injection defense** | Treat uploaded documents (A5) and inbound WhatsApp/email (A6/A7) as untrusted; sanitize; never let document/message text alter agent instructions or trigger actions. |
| **PII minimization** | Redact/limit PII sent to any model; prefer field-level extraction over full-document dumps. |
| **Confidence & fallback** | Each agent has a confidence threshold; below it → route to human, don't auto-act. |
| **Determinism where required** | Pricing, taxes, VIN validation, round-robin = deterministic code, **not** LLM inference. LLMs only for language/extraction/summarization. |
| **Per-agent kill switch** | Every agent toggleable per dealer via Feature Flags (Platform); safe degradation to manual if disabled. |
| **Model/version pinning + cost control** | Pin model versions; budget/rate caps; log token/cost per agent run. |
| **Auditability** | Every agent decision → Audit Logs + record Activity (input summary, output, confidence, human approver). |
| **Evaluation & monitoring** | Track agent acceptance/override rates and error rates; surface to Admin in the AI Agents console. |

### 17.4 Observability & Operations
| Element | Approach | Tag |
|---|---|---|
| Structured logging | Correlated request/agent logs (no PII) | 🟢 |
| App & agent metrics | Counts, latencies, SLA timers, agent acceptance/override rates | 🟢 |
| Audit trail | Immutable, queryable (Audit Logs section) | 🟢 |
| Distributed tracing / APM | Managed tracing stack | 🔴 (infra) |
| Alerting / on-call | Alert routing, dashboards | 🔴 (infra) |

### 17.5 Reliability, Backup & Disaster Recovery — 🔴 WAIT FOR INFRA
**Keep in scope; do not build until infra is provisioned.** Build data export/import seams now; leave DR wiring for later.
- RPO/RTO targets, automated backups, point-in-time restore, multi-region failover — **PENDING INFRA**.
- Directly answers the BRD "Risk of Data Loss" pain point — flag as designed-but-deferred so the client sees it's addressed, not ignored.

### 17.6 Integration Architecture & Resilience
| Pattern | Requirement | Tag |
|---|---|---|
| Adapter pattern | Every external capability (telephony, WhatsApp, email, GRA) behind an interface with a default stub | 🟢 |
| Idempotency | Idempotency keys on payment/invoice/allocation to prevent duplicates on retry | 🟢 |
| Outbound reliability | **DB-backed outbox** for messages/invoices with retry + backoff now; swap to managed queue/broker later | 🟡 |
| Webhook security | Verify signatures on inbound webhooks (WhatsApp/telephony) | 🟢 |
| Circuit breakers / timeouts | Fail gracefully to manual when a provider is down | 🟢 |
| Managed message broker | Kafka/SQS-style infra | 🔴 (infra) |

### 17.7 Data Migration Plan (Excel → DMS) — 🟢
Field mapping (incl. images) → validation (VIN 17, reg pattern, dedup) → **dry-run with reconciliation report** → import → post-load counts vs. source → rollback path. One-time, not an ongoing integration.

### 17.8 Testing & UAT Strategy — 🟢
Unit + integration + end-to-end (happy path per module); seed/test data; per-module RBAC tests; a UAT environment with client sign-off mapped to the §16 acceptance criteria.

### 17.9 Localization & Environment — 🟢
Currency **GYD + USD with exchange rate** (parts costing already dual-currency); timezone **Guyana (GMT-4)**; low-bandwidth-friendly UI and **WhatsApp-first** customer comms (developing-market reality the client stressed).

### 17.10 Configuration & Change Management — 🟢
Effective-dated tax definitions; versioned pipeline/stage & checklist config; feature flags per dealer; all config changes captured in Audit Logs.

### 17.11 Summary — build-now vs. wait
| Wait for your infra (🔴) | Build now (🟢/🟡) |
|---|---|
| Uptime SLA & horizontal scale · Encryption at rest / managed DB · DR/backup/failover · Managed tracing/alerting · Managed message broker | Everything else: RBAC, validation, rate limiting, **full AI governance**, idempotency, DB-backed outbox + retries, webhook verification, migration tooling, testing, localization, config mgmt, structured logging & metrics, secrets via Replit Secrets |

---

## 18. Requirements Traceability Matrix (proof of alignment)

Every stated requirement → where it's covered. **Source:** BRD = GT Automotives BRD · Call = 20 Jul 2026 transcript · v2 = Functional Spec v2. Use this to show the client nothing was dropped.

| # | Requirement | Source | Covered in |
|---|-------------|--------|-----------|
| 1 | Combine Lead Source + Channel; social sub-platform | Call, v2 | §7 New, §8.1 |
| 2 | Mandatory Address on lead | Call, v2 | §7 New, §8.1 |
| 3 | Multi-select Interested Models w/ financing & test-drive flags | Call, v2 | §7, §8.1, DataModel |
| 4 | Duplicate leads append, not duplicate | BRD, Call, v2 | §5 A1, §8.1 |
| 5 | "Lead Owner" → "Sales Advisor"; ownership transfers | Call, v2 | §2, §7 |
| 6 | Timestamp round-robin auto-assign; no qualification gate | BRD, Call, v2 | §5 A2, §8.1 |
| 7 | Unresponsive cadence 24h/+3d/+3d/+7d → close w/ reason; Revisit-in-3-months | BRD | §7 (cadence), §8.1 |
| 8 | Reason-for-Lead-Closure picklist | BRD | §7 |
| 9 | Click-to-call from lead; notes; call summary; sentiment | Call | §5 A6, §8.1 |
| 10 | Call summary as **Activity**, not in "New Lead" view | Call | §5 A6, §8.1 |
| 11 | Code auto-generated on lead creation, any source | Call, v2 | §5 A3, §8.2, §7 New |
| 12 | GT exact code format (name, address, quote#, model year, date sent) | Call, v2 | §8.2 |
| 13 | Manufacturing Year mandatory; Mfg date from asset | Call, v2 | §8.2, §8.4 |
| 14 | Generate/resend code anytime on change | Call, v2 | §5 A3, §8.2 |
| 15 | Configurable taxes per dealer at vehicle/asset level | Call, v2 | §8.2 |
| 16 | VAT 0/14% + duty-free threshold (EV exclusion TBD) | Call, v2 | §8.2, §15 |
| 17 | 24h Contact SLA; visual flag on breach (Advisor+Manager), no escalation | BRD, Call, v2 | §5 A9, §7 Contacted, §11 |
| 18 | Test drive only after first contact | Call, v2 | §7 Engaged |
| 19 | Test drive checks customer + vehicle availability; soft-lock single unit | Call, v2 | §5 A10, §8.4 |
| 20 | 24h test-drive reminder w/ Yes/No confirm (WhatsApp) | BRD, Call, v2 | §5 A10, §8.12 |
| 21 | Financing qualified via doc upload, manually overridable ("blind eye") | Call, v2 | §5 A5, §7 Engaged |
| 22 | "Not Interested" first-class close | Call, v2 | §7 Engaged |
| 23 | Straight-through processing for simple single-model leads | Call | §5 A8 |
| 24 | Rename "Order Confirmed" → **Pre-Book** | Call, v2 | §7 |
| 25 | Reservation fee mandatory to enter Pre-Book; capture fee/date/mode/receipt | BRD, Call, v2 | §7 Pre-Book |
| 26 | Trusted-customer deposit bypass w/ comment | BRD | §7 |
| 27 | Account+Contact created/linked at Pre-Book; reuse existing | BRD, Call, v2 | §8.3, §7 |
| 28 | Selected Model set only after reservation fee; distinct from Interested | Call, v2 | §7, §8.3 |
| 29 | VIN(17)+Engine# validation at allocation; auto-suggest from Selected | BRD, Call, v2 | §5 A11, §7, §11 |
| 30 | Soft-lock allocated vehicle (reserved, not sold) | Call, v2 | §7, §8.4, §17.1 |
| 31 | Two payment methods (reservation + final); Bank Financing/Cash/Cheque | BRD, Call, v2 | §7 Payment, §8.9 |
| 32 | Negotiated final amount ≠ code amount | Call, v2 | §8.9 |
| 33 | Invoice at **both** reservation and final payment; re-sendable | BRD, Call, v2 | §5 A12, §8.9 |
| 34 | Cancellation → Manager approval → Finance refund → history retained | BRD, Call, v2 | §6, §7, §8.9 |
| 35 | Pre-filled handover/warranty PDFs (print-sign-scan-upload) | BRD, Call, v2 | §5 A13, §8.5, §8.10 |
| 36 | Registration 3rd-party — status/checklist only | BRD, Call, v2 | §8.5 |
| 37 | Expected vs Actual delivery dates | BRD, Call, v2 | §7 Delivered, §8.5 |
| 38 | Delivered vehicle → Asset on Account | BRD, Call, v2 | §8.3, §7 |
| 39 | Feedback survey within 24h of delivery | BRD, Call, v2 | §5 A14, §8.5 |
| 40 | Handoff to Service Advisor post-delivery (SLA 24h/7d TBD) | BRD, Call, v2 | §8.5, §15 |
| 41 | Household & business account grouping (manual) | Call, v2 | §8.3 |
| 42 | Guidance-for-Success checklist + **hard stop** (AI) per stage | BRD, Call, v2 | §5 A4, §6, §7 |
| 43 | Human-in-loop review/approval points | Call | §6 |
| 44 | Document management, no gov-ID verification; types + "Add New"; ≤20MB | BRD, Call, v2 | §8.10 |
| 45 | AI document pre-fill of lead fields | Call | §5 A5 |
| 46 | Service: scheduled (cadence) + unscheduled; Case→Mgr review→Work Order | BRD, Call | §8.6 |
| 47 | Cadences tweakable per dealer; free-service count (e.g., 3) | BRD, Call | §8.6 |
| 48 | One active Work Order per asset; WO types/statuses; Pay Type | BRD | §8.6 |
| 49 | Parts inventory & costing (USD/GYD, freight, duty, VAT) — Phase 2 lean | BRD, Call | §8.7, §14 |
| 50 | Technician/workshop flow | BRD | §8.8 |
| 51 | Warranty & Claim objects (types TBD) | BRD | §8.6, §15 |
| 52 | Reports & dashboards persona-aware | BRD, Call, v2 | §3, §8.12, §12 |
| 53 | Distinct dashboards: Advisor / Manager / **Leadership both divisions** | Call, v2 | §3, §13 |
| 54 | Land on dashboard/Daily Briefing, not list | Call, v2 | §4, §5 A16 |
| 55 | Notifications matrix (in-app/email/WhatsApp); WhatsApp primary | BRD, Call, v2 | §8.12 |
| 56 | **Single source of truth in-system (Vishok)** | Call | §4, §13 |
| 57 | Two portals: dealer-admin vs super-admin | Call | §1 |
| 58 | Employee Master & org hierarchy (multiple Sales Managers) | Call, v2 | §2 |
| 59 | 6 showrooms; every unit tagged; no cross-showroom transfer | Call, v2 | §1, §8.4 |
| 60 | Search by last-9 VIN / Registration / Email | BRD | §11 |
| 61 | Reg-number pattern (3 letters + 1–4 digits) | BRD | §8.4, §11 |
| 62 | Excel inventory migration (incl. images) | BRD, Call, v2 | §8.4, §17.7 |
| 63 | GRA / VAT compliance filing | UI, Call (tax) | §8.11 |
| 64 | Accounting/ERP (QuickBooks/GL) — Phase 2 | Call | §14 |
| 65 | Customer portal, DocuSign — deferred | Call, v2 | §14 |
| 66 | Advisor-driven WhatsApp/email request-info composer | *Derived* from Call (WhatsApp-first + remove touchpoints) | §5 A7 ⭐ (flagged as enhancement) |

**Coverage note:** Items #16, #40, #47, #49, #51 depend on the §15 open questions and are covered but marked *pending client confirmation*. Item #66 is the one **enhancement beyond the literal BRD**, explicitly flagged.

---
*Prepared by KSquare Solutions. Cross-check against the client's full BRD and Miro board; re-confirm §15 before build sign-off. §17.5 and other 🔴 items are designed-but-deferred pending client-provided infrastructure — do not block Phase 1.*
