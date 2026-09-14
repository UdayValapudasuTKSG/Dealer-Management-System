---
name: Deal stage progression has no manual control
description: How deals actually move to committed/delivered — orchestration-only, no UI stage picker
---

Deals have NO manual stage control anywhere in the UI (by design). The only paths forward:

- Finance application **approved** → auto-opens the delivery workflow (`ensureDeliveryForDeal`, idempotent).
- Finance application **disbursed** → deal auto-advances to `committed` (and, as a safety net, also ensures a delivery exists).
- Completing the **final delivery workflow step** (feedback) → deal becomes `delivered`, vehicle `delivered`, asset added to the customer garage.
- Sandbox LOS: "Check Lender Status" advances the application ONE stage per click (submitted → under_review → approved/declined → disbursed).

**Why:** the deal PATCH route enforces one-step transitions, but no client sends stage patches; orchestration owns progression. Testing agents repeatedly wasted cycles looking for a stage picker on /deals or the lead rail.

**How to apply:** to drive a deal to Delivered in tests, go through /finance (create app → sync to disbursed) then /deliveries (advance all 9 steps; PDI PATCH body key is `items`, steps need registrationNumber / appointmentAt / signatureName / feedbackRating).

## Reopening steps (Aug 2026)
POST /deliveries/:id/revert sets a completed/skipped step back to pending (pointer = earliest pending). Blocked once delivery.status=completed — handover side effects are irreversible. Design rules:
- Revert runs in a tx with SELECT … FOR UPDATE; keep it that way (advance's whole-array write is still unguarded — don't copy that pattern).
- Re-advancing after a reopen must NOT repeat side effects: appointment email/notify skipped unless the time changed (deduped via delivery_appointment timeline event); feedback CSAT review is upserted, not inserted.
- RBAC: the revert path is overridden to deliveries:edit (not create); UI shows Reopen only with that permission.

## Reviewed imports with later payment entry

An explicitly reviewed import may bring previously sold vehicles into **pending** delivery workflows. A source spreadsheet saying “Delivered” does not authorize completed steps or signatures. Confirmed quoted selling prices are separate from payment-ledger evidence.

**Why:** The dealership may need to generate handover/warranty documents and perform workflow checks for sales whose payments have not yet been entered in AURA. Fabricated payments or copied completion flags would defeat those checks.

**How to apply:** Keep this as an audited import exception, not a relaxation of normal commitment rules. Preserve source dates separately, suppress customer communications by imported-record provenance, and require ledger-backed settlement before final handover—even if an invoice is manually marked paid.
