---
name: Shipment allocation approval boundary
description: Business approval prerequisite and unresolved VIN-allocation policy conflict.
---
The user required a BRD before shipment-allocation implementation and has now explicitly requested implementation of the supplied revised flow. This authorises development, not automatic production migration, real customer messages, or bypassing existing financial holds.

**Why:** Manifest-driven permanent VIN assignment in the proposal overlaps existing specification-only demand, paid reservation holds and deal-commitment rules. Automatically treating it as approved could change customer entitlement and financial controls.

**How to apply:** Obtain explicit decisions on Pre-Book eligibility, shipment capacity consumption, VIN commitment timing, shortage fairness and multi-unit partial fulfilment before implementation. Recommendations in the approval draft are not approved rules. Preserve random matching as a source requirement; distinguish random VIN identity matching from random customer priority during shortages.

## Supplied business-review revision
The user supplied a revision labelled “Approved Business Scope,” first requested an explanation, then explicitly requested implementation. It specifies quantity-only allocations before real factory VINs, no dummy VINs for operational shipment bridging, oldest eligible baseline-timestamp priority with random exact-match VIN identities, single-editor locks with timeout/read-only visibility, and valid-row imports with error reports.

**Why:** These are explicit changes to the earlier draft, not blanket approval of its recommendations. The revised document still conflicts internally on proposed versus permanent VIN claims; its one-month ETA notification threshold is approximate, and multi-unit fulfilment and active-shipment rules are not fully resolved. Catalogue confirmation remains pending despite the approval heading.

**How to apply:** Use the revised business directions when explaining or preparing a consolidated BRD. Resolve the remaining contradictions before coding. Keep isolated ERP accounting-test fixtures distinct from operational shipment records; test-data authorisation does not authorise placeholder VINs for customer allocations. Do not treat the status label as authorisation to migrate production or send customer messages.

## Catalogue and initial rollout
The user explicitly selected a manager-maintained approved specification catalogue, rather than waiting for an external spreadsheet.

**Why:** Existing inventory does not provide all required matching attributes, especially interior colour; inferred or blank catalogue values would undermine exact matching.

**How to apply:** Managers approve explicit specifications before allocations/imports use them. Do not derive catalogue approval from existing stock. VIN confirmation must preserve the established fully paid reservation boundary; lacking eligibility should leave an actionable pending proposal, not a new unpaid claim.

The user subsequently authorised connecting allocation/ETA emails and preparing the two templates. New production events may use the dealer's email service; development and historical withheld events must not be replayed automatically.

**Why:** Connecting delivery must not unexpectedly release accumulated test/historical notifications.

**How to apply:** Keep template test-sends explicit, dealer-scoped and separate from automatic shipment events. Preserve customer opt-out/import suppression and no-global-sender rules. Do not introduce an automatic historical catch-up sweep.
