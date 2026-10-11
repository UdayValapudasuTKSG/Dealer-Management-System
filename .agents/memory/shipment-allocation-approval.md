---
name: Shipment allocation approval boundary
description: Business approval prerequisite and unresolved VIN-allocation policy conflict.
---
The user requires a BRD and approval before shipment-allocation implementation. Treat the supplied functional requirements as proposed scope, not authorization to change allocation behavior.

**Why:** Manifest-driven permanent VIN assignment in the proposal overlaps existing specification-only demand, paid reservation holds and deal-commitment rules. Automatically treating it as approved could change customer entitlement and financial controls.

**How to apply:** Obtain explicit decisions on Pre-Book eligibility, shipment capacity consumption, VIN commitment timing, shortage fairness and multi-unit partial fulfilment before implementation. Recommendations in the approval draft are not approved rules. Preserve random matching as a source requirement; distinguish random VIN identity matching from random customer priority during shortages.

## Supplied business-review revision
The user subsequently supplied a revision labelled “Approved Business Scope” for explanation, not a new implementation request. It specifies quantity-only allocations before real factory VINs, no dummy VINs for operational shipment bridging, oldest eligible baseline-timestamp priority with random exact-match VIN identities, single-editor locks with timeout/read-only visibility, and valid-row imports with error reports.

**Why:** These are explicit changes to the earlier draft, not blanket approval of its recommendations. The revised document still conflicts internally on proposed versus permanent VIN claims; its one-month ETA notification threshold is approximate, and multi-unit fulfilment and active-shipment rules are not fully resolved. Catalogue confirmation remains pending despite the approval heading.

**How to apply:** Use the revised business directions when explaining or preparing a consolidated BRD. Resolve the remaining contradictions before coding. Keep isolated ERP accounting-test fixtures distinct from operational shipment records; test-data authorisation does not authorise placeholder VINs for customer allocations. Do not treat the status label as authorisation to migrate production or send customer messages.
