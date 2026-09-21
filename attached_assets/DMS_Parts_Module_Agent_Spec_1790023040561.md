# Parts Module — Implementation Spec (Agent Build Brief)

**Project:** Dealer Management System (DMS) — CAM Motors / GT Automotive
**Scope:** Parts & Inventory module
**Source:** Requirements gathered from Faraz, 09/18/2026
**Status:** Draft — ready for implementation planning. Complexity/sizing not yet estimated; treat priority as the sequencing signal.

---

## 0. How to use this document

This is a build brief for an AI coding agent (Replit Agent or similar). Each requirement below is written as an implementable unit: user story → acceptance criteria → data/API touchpoints → edge cases. Build in priority order (High → Medium → Low) unless a dependency forces otherwise (dependencies are called out per item).

**Stack assumption (adjust to match the actual repo):** Node.js/Express (or similar) API + PostgreSQL + a React frontend. If the target Replit project already has an established stack, framework, ORM, and folder structure, the agent should conform to those instead of what's assumed here — this doc describes behavior and data shape, not a mandated tech stack.

Before starting, the agent should:
1. Confirm/inspect the existing schema for `parts`, `inventory`, `repair_orders`, `invoices`, `suppliers`, and `locations` tables if they already exist in the project, and extend rather than duplicate them.
2. Confirm whether multi-branch/multi-location support already exists elsewhere in the DMS (it's referenced as a dependency by several items below).
3. Flag any requirement below that conflicts with existing schema/business logic rather than silently overriding it.

---

## 1. Core data model additions

These entities are referenced across multiple requirements; define them once, centrally.

```
Supplier
  id, name, email, phone, address, lead_time_days, active

Location            (branch / warehouse)
  id, name, type [branch|warehouse], address, active

Bin
  id, location_id (FK), code, description

Part
  id, sku, name, description, category, unit_cost, unit_price,
  costing_method [average|fifo|landed], reorder_min, reorder_max,
  active, created_at, updated_at

InventoryLevel        (part quantity per location/bin — the "live" stock table)
  id, part_id (FK), location_id (FK), bin_id (FK, nullable),
  quantity_on_hand, quantity_reserved, quantity_available (computed),
  updated_at

InventoryTransaction   (append-only ledger — every quantity change flows through this)
  id, part_id (FK), location_id (FK), bin_id (FK, nullable),
  type [receipt|issue|transfer|adjustment|cycle_count|return],
  quantity_delta, reference_type [RO|invoice|po|transfer|cycle_count|credit_note],
  reference_id, unit_cost_at_transaction, created_by, created_at

PurchaseOrder
  id, supplier_id (FK), status [draft|sent|partially_received|received|closed],
  source [manual|low_stock_alert|special_order], created_by, created_at, expected_date

PurchaseOrderLine
  id, po_id (FK), part_id (FK), quantity_ordered, quantity_received, unit_cost

InventoryHold          (soft reservation)
  id, part_id (FK), location_id (FK), quantity, reference_type [job|estimate|quote],
  reference_id, status [active|released|consumed], created_at, released_at

CycleCount
  id, location_id (FK), bin_id (FK, nullable), category (nullable),
  status [in_progress|completed], started_by, started_at, completed_at

CycleCountLine
  id, cycle_count_id (FK), part_id (FK), expected_qty, counted_qty, variance

Notification
  id, type, recipient_id, channel [sms|internal], reference_type, reference_id,
  status [pending|sent|failed], sent_at
```

Notes:
- `InventoryLevel.quantity_available` = `quantity_on_hand - quantity_reserved`. Compute this, don't store it as an independently-writable column — derive it or keep it in sync via the transaction/hold layer.
- Every stock-quantity change (receipt, billing, transfer, adjustment, cycle count, credit note) should write an `InventoryTransaction` row. This is what powers real-time updates (PARTS-003), aging reports (PARTS-011), and valuation (PARTS-012) without needing separate audit plumbing later.

---

## 2. Requirements

### PARTS-006 — Auto-generate POs from low-stock alerts or special orders
**Priority:** High

**User story:** As a parts manager, when stock hits the reorder minimum, or a customer places a special order for a part not in stock, I want a Purchase Order generated automatically so I don't have to build it by hand.

**Acceptance criteria:**
- A background job (or a triggered check on relevant inventory writes) compares `quantity_available` to `Part.reorder_min` per location and flags parts that have crossed the threshold.
- Flagged parts are grouped by `Supplier` (parts need a default/preferred supplier reference — add `Part.default_supplier_id` if not already modeled) into draft `PurchaseOrder` + `PurchaseOrderLine` records, with `source = low_stock_alert`.
- A special-order request (a part not currently stocked, tied to a customer job/estimate) can independently trigger a draft PO with `source = special_order`, linked to the originating job/estimate.
- Draft POs land in a review queue — they are NOT auto-sent to suppliers without human approval.
- Quantity suggested = `reorder_max - quantity_available` (or the special-order quantity, whichever applies).

**Edge cases:** multiple locations independently below threshold for the same part → either one consolidated PO or one per location (confirm with stakeholder; default to per-location to keep receiving simple). Part with no default supplier → surface in the queue as "needs supplier" rather than silently skipping.

**Depends on:** Part/Supplier/PO schema above; reorder_min/max fields.

---

### PARTS-003 — Real-time inventory updates on RO billing / OTC invoices
**Priority:** High

**User story:** As inventory needs to stay accurate, when a part is billed to a Repair Order or sold over the counter, stock should decrement immediately, not on a batch job.

**Acceptance criteria:**
- Billing a part to an RO line item or an OTC invoice line item synchronously creates an `InventoryTransaction` (`type = issue`, `reference_type = RO` or `invoice`) and updates `InventoryLevel.quantity_on_hand` in the same transaction/commit — no eventual-consistency window.
- If `quantity_available` is insufficient, the UI blocks the line item (or requires explicit backorder override) rather than allowing negative stock silently.
- This should be the single write path — PARTS-008/014 (holds) and PARTS-015 (issue to job cards) reuse the same transaction-writing logic, not a parallel implementation.

**Edge cases:** voided/edited RO line after billing needs a reversing transaction, not a raw update. Concurrent billing of the same part across two ROs — use a row lock or optimistic concurrency check on `InventoryLevel` to avoid a lost-update race.

---

### PARTS-008 / PARTS-014 — Soft hold on inventory for jobs, estimates, quotes
**Priority:** High
*(These two rows are functionally the same feature — service jobs/customer estimates in PARTS-008, active quotes/jobs in PARTS-014 — implement once.)*

**User story:** As a service advisor, when I attach a part to an estimate, quote, or job, I want it reserved so another advisor can't sell it out from under me before the job is confirmed.

**Acceptance criteria:**
- Creating/confirming a line item on an estimate, quote, or job creates an `InventoryHold` (`status = active`) and increments `InventoryLevel.quantity_reserved`.
- `quantity_available` (used everywhere stock is checked/displayed) always reflects on-hand minus active holds.
- Hold is released (`status = released`, decrement `quantity_reserved`) when the estimate/quote is cancelled or expires (define an expiry — e.g., configurable days, default 7).
- Hold is consumed (`status = consumed`) and converted into an actual `issue` transaction when the job is billed (ties into PARTS-003/PARTS-015 write path).

**Edge cases:** hold quantity exceeding available stock — allow but flag as backorder risk, don't hard-block (estimates are written before stock is guaranteed). Expired holds need a sweep job.

---

### PARTS-009 — Automated notifications when special-order parts are received
**Priority:** High

**User story:** As an advisor waiting on a special-order part, I want to be notified the moment it arrives so I can call the customer.

**Acceptance criteria:**
- Receiving a `PurchaseOrderLine` where the originating PO has `source = special_order` triggers a `Notification` to the advisor/manager tied to the originating job/estimate.
- Support both channels noted in the requirement: SMS and internal (in-app) alert. Reuse the existing SMS delivery tool/gateway already in the DMS stack if present, rather than building a new SMS integration — check for it before adding a new provider.
- Notification failure (e.g., SMS gateway down) should not silently drop — log to `Notification.status = failed` and surface in an admin view.

**Depends on:** PARTS-006 (POs need a special-order link), existing SMS gateway integration if present.

---

### PARTS-013 — Bulk-import parts master list with pricing/costing formulas
**Priority:** High

**User story:** As a parts manager onboarding a new catalog, I want to bulk-upload parts via file rather than entering them one at a time, with pricing computed automatically from cost using configurable formulas.

**Acceptance criteria:**
- CSV/XLSX upload endpoint that maps columns to `Part` fields (sku, name, description, category, unit_cost, costing_method, reorder_min/max).
- Configurable pricing formula applied on import (e.g., `unit_price = unit_cost * markup_factor`, with markup configurable per category or globally) — don't hardcode a single global markup if the business has category-specific pricing; make it a lookup table.
- Validation pass before commit: duplicate SKUs, missing required fields, negative costs → surfaced as a pre-import error report, not a partial silent import.
- Support update-in-place for existing SKUs (upsert) vs. reject-on-duplicate — make this a user-selected import mode.

**Edge cases:** large file (thousands of rows) — process as a background job with progress/status rather than blocking the request.

---

### PARTS-015 — Issue stock to Job Cards / process Credit Notes for returns
**Priority:** High

**User story:** As a technician closes out a job, parts used should be issued from stock, and any unused/returned parts should generate a credit note back to inventory.

**Acceptance criteria:**
- Issuing stock to a Job Card: consumes the relevant `InventoryHold` if one exists (see PARTS-008/014), otherwise creates a direct `issue` transaction.
- Credit Note flow: returning a part creates a `return` `InventoryTransaction` (positive quantity_delta), restoring `quantity_on_hand`, and generates a credit note record against the original invoice/job for the customer/accounting side.
- Returned parts should be inspectable (condition flag: resalable vs. damaged/scrap) — damaged parts increment stock in a separate non-sellable state or get written off rather than re-entering sellable inventory blindly.

**Depends on:** PARTS-003 write path, PARTS-008/014 holds.

---

### PARTS-001 — Create parts orders + email supplier from within the system
**Priority:** Medium

**User story:** As a parts manager, I want to create a parts order and email it to the supplier without leaving the system.

**Acceptance criteria:**
- "Create Order" flow producing a `PurchaseOrder` (manual source) with line items, distinct from the auto-generated flow in PARTS-006 but sharing the same underlying tables.
- "Send to Supplier" action renders a PO document (PDF or formatted HTML email) and sends it to `Supplier.email` via the system's existing email integration (check for an existing transactional email provider/service before adding a new one).
- Sent POs move to `status = sent` and are timestamped; resending should be possible but logged (don't silently allow duplicate sends without visibility).

---

### PARTS-010 — Perpetual cycle counts by bin/category without halting operations
**Priority:** Medium

**User story:** As a warehouse lead, I want to run rolling cycle counts on a subset of bins/categories at a time, without freezing the whole warehouse.

**Acceptance criteria:**
- Cycle count is scoped to a `location` + optional `bin` or `category` filter — not global.
- Only the parts within scope are locked/flagged "counting in progress" (block conflicting adjustments to those specific parts, not the whole location).
- Counted quantities are entered per part; variance (`counted_qty - expected_qty`) is calculated and requires manager approval before it posts as an `adjustment` transaction.
- Other parts outside the scoped count remain fully transactable (receiving, billing, etc.) throughout.

---

### PARTS-011 — Aging reports for idle/non-moving/obsolete stock
**Priority:** Medium

**User story:** As a parts manager, I want to see what stock hasn't moved in 30/60/90+ days so I can act on it.

**Acceptance criteria:**
- Report computes "last movement date" per part per location from `InventoryTransaction` (most recent `issue` or `transfer` type — receipts alone shouldn't count as "movement" for aging purposes, confirm this interpretation with stakeholder).
- Configurable threshold buckets (default 30/60/90+ as stated); report groups parts into buckets with quantity and current inventory value per bucket.
- Filterable by location/category; exportable (CSV at minimum).

**Depends on:** InventoryTransaction ledger being populated by PARTS-003 and related write paths — build this after the transaction ledger is live, not before.

---

### PARTS-012 — Inventory valuation reporting (average cost / FIFO / landed cost)
**Priority:** Medium

**User story:** As accounting/management, I want inventory valuation reported using the costing method configured per part.

**Acceptance criteria:**
- `Part.costing_method` drives the calculation used:
  - `average`: recompute weighted average cost on each receipt.
  - `fifo`: valuation report walks `InventoryTransaction` receipt history in order to value on-hand quantity at oldest-unconsumed cost layers.
  - `landed`: unit cost includes allocated freight/duty/handling — requires a `landed_cost_components` field on `PurchaseOrderLine` or similar to capture the allocation at receipt time.
- Report output: total valuation by part, by location, and grand total, as of a given date.

**Edge cases:** FIFO requires transaction-level cost tracking (`InventoryTransaction.unit_cost_at_transaction`), which must be populated correctly from day one — retrofitting FIFO onto historical data without per-transaction costs isn't possible, so this field is not optional in the schema above.

---

### PARTS-002 — Track inventory across locations, warehouses, bins
**Priority:** Low

**Acceptance criteria:**
- `InventoryLevel` is keyed by `(part_id, location_id, bin_id)` — a part's total stock is the sum across all its location/bin rows, not a single global quantity field.
- UI/reporting supports drilling from total → per-location → per-bin.
- This is largely a foundation item — PARTS-003, 008/014, 010 all depend on this structure existing, so confirm it's built (or already exists) before those.

---

### PARTS-004 — Mobile barcode scanning (receiving, cycle counts, transfers, picking)
**Priority:** Low

**Acceptance criteria:**
- Scan target: part SKU/barcode resolves to a `Part` record; scanning in a receiving/cycle-count/transfer/picking context pre-fills the relevant quantity-entry form instead of manual SKU lookup.
- Mobile-responsive web view (or PWA) is sufficient unless a native app already exists in the project — don't assume native is required.
- Works with standard 1D barcodes at minimum (UPC/Code128); camera-based scanning via the device's browser camera API (no dedicated hardware scanner assumed unless the client specifies one).

**Depends on:** the receiving/cycle-count/transfer/picking flows themselves existing first (this is a UX accelerator layered on top, not a standalone feature).

---

### PARTS-005 — Automated replenishment suggestions (seasonal velocity, lead time, min/max)
**Priority:** Low

**Acceptance criteria:**
- Suggestion engine reads historical `issue` transaction velocity per part (with a seasonal weighting — e.g., trailing 12 months weighted toward the same calendar period in prior years, not just a flat trailing average) plus `Supplier.lead_time_days` and `reorder_min/max` to suggest reorder quantity and timing.
- Output is a suggestion, distinct from PARTS-006's automatic PO generation — this feeds a review list a manager can act on (or optionally promote to PARTS-006's auto-PO flow), it doesn't have to auto-create POs itself.

**Depends on:** InventoryTransaction history (needs real usage data to be meaningful — low priority is appropriate since it needs data maturity, not just code).

---

### PARTS-007 — Reconcile incoming POs, packing slips, vendor invoices
**Priority:** Low

**Acceptance criteria:**
- Three-way match: `PurchaseOrderLine` (ordered qty/cost) vs. received quantity (entered at receiving) vs. vendor invoice (qty/cost, entered or uploaded).
- Discrepancies (quantity mismatch or price variance beyond a configurable tolerance %) are flagged in a reconciliation queue rather than blocking receiving.
- Manual resolution action (accept variance / dispute / adjust) closes the flagged line.

---

## 3. Cross-cutting build order recommendation

Given the dependency chains above, a sensible implementation sequence is:

1. **Foundation:** Core schema (Part, Location, Bin, InventoryLevel, InventoryTransaction) — underlies everything → PARTS-002.
2. **Write path:** Real-time decrement on billing → PARTS-003 (single source of truth for all future stock-changing features).
3. **Reservations:** Soft holds → PARTS-008/014.
4. **Procurement:** PO generation (manual PARTS-001, then automated PARTS-006), receiving, and special-order notifications → PARTS-009.
5. **Job close-out:** Issue-to-job + credit notes → PARTS-015.
6. **Bulk onboarding:** Import tooling → PARTS-013 (useful early for seeding real data, but not a hard blocker for the above).
7. **Operational reporting:** Cycle counts (PARTS-010), aging (PARTS-011), valuation (PARTS-012) — all benefit from the transaction ledger already having real data by this point.
8. **Enhancements:** Barcode scanning (PARTS-004), replenishment suggestions (PARTS-005), PO/invoice reconciliation (PARTS-007).

## 4. Open questions for stakeholder (flag, don't guess silently)

- Multi-location low-stock alerts: one consolidated PO or one per location? (PARTS-006)
- Hold expiry window for estimates/quotes — how many days? (PARTS-008/014)
- Aging report: does a receipt count as "movement," or only outbound activity? (PARTS-011)
- Does an SMS gateway / transactional email provider already exist in this codebase to reuse? (PARTS-009, PARTS-001)
- Barcode scanning: browser-camera based, or is dedicated scanner hardware in scope? (PARTS-004)
