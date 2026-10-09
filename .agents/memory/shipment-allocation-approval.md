---
name: Shipment allocation approval boundary
description: Business approval prerequisite and unresolved VIN-allocation policy conflict.
---
The user requires a BRD and approval before shipment-allocation implementation. Treat the supplied functional requirements as proposed scope, not authorization to change allocation behavior.

**Why:** Manifest-driven permanent VIN assignment in the proposal overlaps existing specification-only demand, paid reservation holds and deal-commitment rules. Automatically treating it as approved could change customer entitlement and financial controls.

**How to apply:** Obtain explicit decisions on Pre-Book eligibility, shipment capacity consumption, VIN commitment timing, shortage fairness and multi-unit partial fulfilment before implementation. Recommendations in the approval draft are not approved rules. Preserve random matching as a source requirement; distinguish random VIN identity matching from random customer priority during shortages.
