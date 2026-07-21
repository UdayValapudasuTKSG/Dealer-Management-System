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

**How to apply:** to drive a deal to Delivered in tests, go through /finance (create app → sync to disbursed) then /deliveries (advance all 11 steps; PDI PATCH body key is `items`, steps need registrationNumber / appointmentAt / signatureName / feedbackRating).
