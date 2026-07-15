# AURA Dealership OS — End-to-End Walkthrough

A complete, step-by-step guide to every module and flow in AURA, from first sign-in to a delivered vehicle and its after-sales life. Follow it top to bottom for the full journey, or jump to any module using the contents below.

---

## Contents

1. [Getting Started](#1-getting-started)
2. [Demo Logins (one per role)](#2-demo-logins-one-per-role)
3. [The Landing Page](#3-the-landing-page)
4. [Finding Your Way Around](#4-finding-your-way-around)
5. [Command Center — Role Dashboards](#5-command-center--role-dashboards)
6. [The Complete Sales Journey (end to end)](#6-the-complete-sales-journey-end-to-end)
7. [After-Sales: Service, Workshop & Parts](#7-after-sales-service-workshop--parts)
8. [Customers & Customer 360](#8-customers--customer-360)
9. [Compliance: GRA Duty Filing](#9-compliance-gra-duty-filing)
10. [Approvals & Tasks](#10-approvals--tasks)
11. [Reports & Journey View](#11-reports--journey-view)
12. [Settings & Administration](#12-settings--administration)
13. [AI Features at a Glance](#13-ai-features-at-a-glance)
14. [Who Sees What — Role Access Summary](#14-who-sees-what--role-access-summary)
15. [Good to Know](#15-good-to-know)

---

## 1. Getting Started

1. Open the app. You land on the cinematic **AURA showroom page** at `/`.
2. Click **Enter Command Center**. If you are signed out you are redirected to the dark **Sign in** card.
3. Sign in with **Google** or **email + password** (see the demo logins below).
4. Your first stop inside the app is the **Pipeline** — the day-to-day heart of the dealership.

The very first account ever created in a fresh environment becomes **General Manager** automatically; every later self-signup starts as **Sales Advisor** until an admin changes their role in Settings.

## 2. Demo Logins (one per role)

Eleven ready-made accounts exist — one for each dealership role — so you can experience the app from every seat. All of them work in the development environment.

| Role | Name | Email | Password |
|---|---|---|---|
| General Manager | Grace Mercer | gm@aura-demo.com | AuraGM!2026#mx41 |
| Sales Manager | Victor Kane | sales.manager@aura-demo.com | AuraSM!2026#qt58 |
| Service Manager | Rhea Douglas | service.manager@aura-demo.com | AuraSVM!2026#zp73 |
| Marketing Advisor | Lena Ortiz | marketing.advisor@aura-demo.com | AuraMA!2026#kd26 |
| Finance Manager | Marcus Vale | finance.manager@aura-demo.com | AuraFM!2026#rw94 |
| Sales Advisor | Owen Blake | sales.advisor@aura-demo.com | AuraSA!2026#hn37 |
| Delivery Advisor | Priya Nair | delivery.advisor@aura-demo.com | AuraDA!2026#vb62 |
| Service Advisor | Caleb Ross | service.advisor@aura-demo.com | AuraSVA!2026#jf85 |
| Parts Advisor | Nina Whitfield | parts.advisor@aura-demo.com | AuraPA!2026#cy19 |
| Technician | Diego Fuentes | technician@aura-demo.com | AuraTech!2026#sl48 |
| Marketing Coordinator | Amara Boyce | marketing.coordinator@aura-demo.com | AuraMC!2026#gu07 |

Tip: open two browsers (or an incognito window) to watch two roles interact — for example, assign a job card as **Service Manager** and see it appear in the **Technician's Workshop** view.

## 3. The Landing Page

- Full-bleed showroom video hero with the AURA brand — this page is public (no sign-in needed).
- **Enter Command Center** takes you into the app (via sign-in if needed).
- The AURA logo inside the app always brings you back here.

## 4. Finding Your Way Around

The app uses a **top navigation bar** with two rows:

- **Primary row — clusters:** Intelligence, Sales, Operations, Clients, Compliance, Settings. Clicking a cluster jumps to its first page.
- **Secondary row — pages** of the active cluster:
  - **Intelligence:** Command Center, Journey, Reports, Approvals, Tasks
  - **Sales:** Pipeline, Deals, Appraisals, F&I
  - **Operations:** Inventory, Deliveries, Service, Parts, Workshop
  - **Clients:** Customers
  - **Compliance:** GRA Filing
  - **Settings:** Users, Roles & Permissions, Audit Logs, Email Engine

You only see the clusters and pages your role is allowed to view.

Also in the top bar:

- **Global search** — press **Ctrl+K** (or Cmd+K) anywhere to search customers, vehicles, leads, invoices, bookings and service records at once. Type, arrow down, Enter to jump.
- **Notification bell** — live alerts (assignments, approvals, status changes). Click one to jump to the item.
- **Sun/Moon toggle** — switches between the default dark theme and the light theme; your choice is remembered.
- **Avatar menu** — shows your name and role; sign out from here.
- **Concierge launcher** (bottom right) — opens the AI assistant on any page. Ask it things like "how many vehicles are in stock?" or "show me today's deliveries" and it answers with live dealership data, and can navigate you to the right page.

## 5. Command Center — Role Dashboards

**Intelligence → Command Center** (`/command-center`) adapts to who is signed in:

- **General Manager** gets the full cinematic dashboard: revenue trajectory chart, four KPI cards with sparkline, inventory mix donut, sales pipeline funnel with open value, units delivered bars, plus pending decisions and the autonomous activity feed.
- **Sales Manager** sees pipeline health, team performance and open deals.
- **Finance Manager** sees application queues, disbursements and outstanding balances.
- **Service Manager / Service Advisor** see today's bookings, open job cards and invoices.
- **Technician** sees their assigned job cards.
- **Sales / Delivery / Parts Advisors and Marketing roles** each get a focused view of their own queue.

Sign in as different personas to compare — this is the fastest way to feel the role-based design.

## 6. The Complete Sales Journey (end to end)

This is the core flow, from a fresh enquiry to keys-in-hand. Best experienced as **General Manager** or **Sales Manager** (they can do every step). Roughly 10 minutes.

### Step 1 — Capture a lead
1. Go to **Sales → Pipeline**.
2. Click **New Lead** and fill in name, contact, source and (optionally) the vehicle of interest. Coming from a real enquiry email? The lead's email address matters — lifecycle emails go there.
3. The lead appears in the **New Lead** stage of the pipeline rail. A `lead_received` email is queued automatically.

### Step 2 — Work the pipeline
1. The Pipeline page is a clickable **stage rail**: New Lead → Working → Appointment → Desking → Delivered.
2. Select any stage to see its leads and the **AURA recommends** panel — AI-generated next-best actions for that stage.
3. Open a lead to assign an advisor (triggers a `lead_assignment` email + notification), log activity, or advance the phase. Moving to **Appointment** queues a test-drive confirmation email.

### Step 3 — Appraise the trade-in (optional)
1. Go to **Sales → Appraisals** and click **New Appraisal**.
2. Enter the customer's current vehicle details and condition; record the appraised value that will feed the deal.

### Step 4 — Desk the deal
1. Go to **Sales → Deals** and create a **New Deal** linking customer + vehicle.
2. Work the numbers (price, trade-in, add-ons → out-the-door price). Advancing the deal stage drives everything downstream:
   - **Finance** stage → finance-processing email
   - **Committed** → finance-approved and vehicle-booking emails
   - **Delivered** → delivery confirmation email + counts toward monthly revenue

### Step 5 — F&I application
1. Go to **Sales → F&I** (`/finance`). The connector pill at the top shows which Loan Origination System is connected (sandbox mode by default — deterministic, safe to demo).
2. From a lead you can also click **Open F&I** — it prefills and opens the new-application dialog automatically.
3. Create the application, then open it to see the **status stepper**: pending → submitted → under review → approved/declined → disbursed.
4. Click **Submit to Lender**, then **Check Lender Status** to advance it (in sandbox each check moves one stage; it declines if debt-to-income exceeds 45% or income is missing).
5. Upload supporting documents in the same dialog; every transition is logged in the timeline and LOS log.
6. On **disbursed**, the linked deal automatically advances to **Committed**, receipts are issued, and Finance users are notified. Declines raise a credit-decline decision gate in Approvals.
7. The **Invoices & Payments / Receipts / Outstanding** tabs track money: recording a payment auto-issues an `RCT-` receipt and updates the invoice.

### Step 6 — Booking & the 11-step delivery
1. Go to **Operations → Deliveries**. A committed deal creates the delivery pipeline entry.
2. Open it and walk the **11-step delivery checklist** (PDI, detailing, registration, insurance, fuel, handover pack, and so on) — tick steps off as completed.
3. Completing delivery marks the deal **Delivered**, sends the confirmation email, and the customer's journey stage updates everywhere.

### Step 7 — Verify the paper trail
- **Intelligence → Approvals** — any human decision gates raised along the way (credit declines, GRA filings) wait here for approve/dismiss.
- **Settings → Audit Logs** — every mutating action you just performed is logged with who/what/when.
- **Settings → Email Engine** — see every lifecycle email that was queued during the journey.

## 7. After-Sales: Service, Workshop & Parts

Best experienced as **Service Manager**, with a second window as **Technician**.

### Service (Operations → Service)
Four tabs: **Bookings / Job Cards / Invoices / Warranty & AMC**.

1. **Book a service:** create a booking with customer, vehicle and scheduled date. When an order is completed the customer gets a "vehicle ready" email; you can also send a **service reminder** from the order (needs the customer to have an email on file).
2. **Job cards:** open a card from a booking; assign a **Technician** (they get notified). The card flows **open → in progress → quality check → completed**.
3. **Invoices:** a completed job card rolls into a service invoice — parts + labour + 15% tax. Invoices go **issued → paid/void**.
4. **Warranty & AMC:** track coverage per vehicle and send **warranty reminder** emails.

### Workshop (Operations → Workshop)
The technician's own view — sign in as **Diego Fuentes (Technician)** and you'll see only the job cards assigned to you, ready to advance through the workflow.

### Parts (Operations → Parts)
Three tabs: **Parts / Suppliers / Purchases**.

1. Stock levels are tracked per part; anything at or below its reorder level is flagged **low stock**.
2. Issuing a part to a job card **decrements stock** (the system refuses if there isn't enough); returning it restocks.
3. Record suppliers and purchase orders to replenish inventory.

## 8. Customers & Customer 360

**Clients → Customers** lists everyone, with loyalty tiers (gold/silver) and search.

Click a customer to open their **360° profile**:

- **Journey Stage stepper** — a read-only view of how far they've progressed (derived from their furthest lead phase and deal stage).
- **Profile** — contact details and preferences, editable inline.
- **Persona** — AI-built buyer persona plus a **vehicle recommendation** button that suggests stock matched to their profile.
- **Communications** — every email sent to them, plus the ability to enqueue a templated email or log a note.
- **Documents** — upload and manage customer documents.
- **Notes** — the running internal commentary.

Everything you did in the sales journey (leads, deals, deliveries, service) shows up here against the customer.

## 9. Compliance: GRA Duty Filing

**Compliance → GRA Filing** (`/gra`) handles import duty:

1. Upload a photo/scan of an import document.
2. Click extract — AI vision reads the document and **autofills the duty draft** (vehicle details, values, duty computation).
3. Review and submit — this creates a **GRA filing decision gate** that appears in **Approvals** for a human to approve.

## 10. Approvals & Tasks

- **Intelligence → Approvals** — the human-in-the-loop queue. Every decision gate the system raises (credit declines, GRA filings, and other agent-raised decisions) lands here with full context and approve/dismiss buttons. Dismissals are recorded as rejections in the audit trail.
- **Intelligence → Tasks** — your personal work queue: follow-ups, assignments and reminders generated across the app, checked off as you complete them.

## 11. Reports & Journey View

- **Intelligence → Reports** — a rail of report types (sales performance, inventory, finance, service and more depending on your role); pick one to see its charts and tables.
- **Intelligence → Journey** — the orchestration centerpiece: pick a journey phase and watch how leads, vehicles and AI recommendations line up per phase. It uses the same dealer-grade stage names as the Pipeline.

## 12. Settings & Administration

Visible to roles with settings access (General Manager, and managers where granted).

- **Users** — everyone with a login, their role and status. Change a user's role here (they may need to refresh their browser to pick up new permissions).
- **Roles & Permissions** — the 11 roles and their permission grid: 11 modules (leads, deals, inventory, finance, service, parts, customers, deliveries, appraisals, gra, settings) × 9 action categories. The `admin` category implies everything.
- **Audit Logs** — an immutable trail of every mutating action: who did what, to which record, when — including sign-outs.
- **Email Engine** — every lifecycle email the system has queued (lead received, assignment, test drive, finance processing/approved, booking, delivery, vehicle ready, reminders), with status and recipient.

## 13. AI Features at a Glance

| Feature | Where | What it does |
|---|---|---|
| Concierge chat | Floating launcher, every page | Streams answers using live dealership data; can navigate you around the app |
| Pipeline recommendations | Pipeline page, per stage | Next-best actions for the selected stage's leads |
| Buyer persona + vehicle match | Customer 360 → Persona tab | Builds a persona and recommends in-stock vehicles |
| GRA document extraction | GRA Filing | Reads import documents and autofills the duty draft |
| Role dashboards feed | Command Center | Ambient autonomous-activity feed of what the system did on its own |

## 14. Who Sees What — Role Access Summary

| Persona | Primary workspace | Highlights |
|---|---|---|
| General Manager | Everything | Full dashboard, all modules, all settings |
| Sales Manager | Sales cluster | Pipeline, deals, appraisals, F&I oversight, team reports |
| Finance Manager | F&I | Applications, lender flow, invoices, receipts, outstanding |
| Sales Advisor | Pipeline | Own leads and deals, customer profiles |
| Delivery Advisor | Deliveries | Booking pipeline and 11-step delivery checklists |
| Service Manager | Service | Bookings, job cards, invoices, warranty, technician assignment |
| Service Advisor | Service | Bookings and customer-facing service flow |
| Parts Advisor | Parts | Stock, suppliers, purchases, low-stock alerts |
| Technician | Workshop | Only their assigned job cards |
| Marketing Advisor | Intelligence | Campaign-facing reports and lead sources |
| Marketing Coordinator | Intelligence | Marketing tasks and coordination views |

Menus, pages and even buttons hide themselves when a role lacks the permission — try the same page as two personas to see the difference.

## 15. Good to Know

- **Dark by default, light on demand** — the Sun/Moon toggle in the top bar; the preference sticks per browser.
- **Percentages are pre-scaled** — conversion and success rates display exactly as stored.
- **Demo logins are development-only** — the production user store is separate; the same seeding can be re-run there after publishing.
- **No dead ends** — every list row, card and notification clicks through to its detail view.
- **Emails need an address** — lifecycle and reminder emails are skipped silently when the lead/customer has no email on file.
