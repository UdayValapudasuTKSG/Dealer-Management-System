# AURA shipment flow — initial rollout

Open **Operations → Shipments**. Catalogue, shipment details, customer tracking,
and exceptions are separate pages. This is fulfilment tracking; existing sales
phases and delivery approvals are not replaced.

## 1. Approve the catalogue

Create a specification draft with make, model, model year, variant, exterior
colour and interior colour. An authorised approver approves it. Only approved
entries can be used for shipment lines and matching. Use explicit N/A only
where a specification genuinely does not apply; blanks never match everything.

## 2. Register the shipment

Create a reference and expected arrival month/year. The shipment starts Open.
Add approved specification lines and expected whole-number quantities, manually
or through the import flow. The original ETA is retained alongside current ETA.
Open and In Transit shipments accept allocations. Arrived shipments need
manifest-reconciled capacity. Closing/cancelling/reducing capacity must not
strand active allocations.

## 3. Start editing

The editor lease lasts five minutes, renews while editing and can be released.
Another user sees the holder and read-only state. Server-side locks and checks,
not just the browser banner, protect every write and the last available unit.

## 4. Allocate eligible demand

Choose a customer lead already at the existing approved Pre-Book phase.
Confirm the requested specification, quantity and associated deal if available.
The successful allocation consumes capacity once and records Vehicle Allocated
as fulfilment information. It does not advance the sales phase or assign a VIN.

Full requested quantity is the default. Record explicit customer consent for a
partial allocation. Partial shipment capacity is not permission to partially
commit a deal: existing all-unit financial/claim controls remain authoritative.

Reassignment checks the destination and moves capacity atomically. It retains
original priority and history. Release requires a reason and cannot silently
discard an active physical hold.

## 5. Revise the ETA

Current ETA changes; baseline does not. The initial communication event is
always recorded. ETA-change events qualify for customer communication only
when the revised ETA is in the current or next **dealership calendar month**.
Changes outside this window are logged as suppressed, with a visible reason.
Unsent stale ETA revisions are superseded.

**Email delivery is connected for new production events.**
The dealership's configured SMTP sender, branding, customer opt-outs and
controlled-import communication rules apply. There is no global sender fallback.
Development events remain Withheld and are never automatically replayed.
Historical withheld events also stay withheld after publishing.

In **Settings → Email**, preview and customise **Shipment allocation confirmation**
and **Shipment arrival estimate update**. An explicit template test-send uses
sample information and the recipient you select; automatic shipment events
never send from development. Tracking reflects the actual email outbox state,
not simply whether a notification was created. Sent means accepted by the
email provider, not proof of inbox delivery.

Before each automatic send, the system rechecks allocation, shipment and ETA
eligibility. Shipment edits and the provider handoff are serialized to avoid
sending an outdated update after an edit has already completed.
WhatsApp/SMS and ERPNext postings are outside this shipment scope.

## 6. Import shipment lines or real factory VINs

Use the supplied template. Upload CSV/XLSX, inspect the validation preview, then
confirm. Valid rows are accepted; invalid rows have row-numbered explanations
and an error report. A retry does not duplicate existing lines or manifest VINs.
The server verifies content identity instead of trusting the browser checksum.

Imports never invent vehicles or fill unknown stock attributes. A factory VIN
must be onboarded through Inventory with correct actual attributes before a
physical claim can be confirmed.

## 7. Review VIN matching

Run matching to create saved proposals. Oldest eligible allocations have first
priority within each exact-specification group. VIN identities are randomised
within that group; customer priority is not random. Unmatched VINs, shortages
and blocked proposals remain visible. Re-running does not reshuffle existing
proposals.

Confirmation is a separate authorised action. It validates inventory identity,
specifications, recall/damage flags, existing claims, deal linkage and finance
eligibility. Interior colour requires explicit verification because the current
inventory record has no independent interior-colour field.

Confirmation uses the established reservation ledger. It requires a fully paid
reservation awaiting stock and all required units of the desking deal.
Missing prerequisites leave an actionable blocked proposal. An existing
customer's held/sold/committed VIN cannot be taken.

The resulting hold follows the existing reservation expiry/commitment rules;
it is not a permanent override. Expired/released holds are shown as lapsed.
Re-run matching to reconcile lapsed proposals. No new background reconciliation
worker is included.

## 8. Monitor and deliver

Customer Tracking shows allocation, baseline/current ETA, matched/confirmed
units and communication status. Exceptions shows shortages, onboarding/finance
blockers, lapsed holds, unassigned capacity and withheld communications.
The audit timeline preserves changes and actors.

Normal deal commitment, settlement, PDI, registration and delivery gates still
control handover. Shipment arrival or VIN matching never completes delivery.

## Release boundary

Built and tested in development. No production publication, historical
backfill, live-customer sending or ERPNext accounting change is authorised
by this implementation. Confirm real catalogue data and review the two email
templates and dealer SMTP configuration before publishing. Publication enables
new production shipment emails; it does not replay past events.
