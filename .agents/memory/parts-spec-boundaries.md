---
name: Parts specification boundaries
description: Conservative compatibility decisions for extending procurement and customer billing.
---

Treat internal restock requisitions as non-billable; customer billing requires an explicit customer-linked, authorized request.

**Why:** The supplied specification leaves internal versus customer-facing requisitions unresolved. Automatically invoicing replenishment would create unjustified customer charges.

**How to apply:** Never infer a customer from a supplier, dealership, or unrelated job. Preserve workshop authorization and already-issued stock history when billing parts separately.

Use inventory locations as the operational branch context without inventing branch staff assignments.

**Why:** The existing membership model is dealership-wide. A location on a PO does not establish which managers belong to that branch.

**How to apply:** Explicit branch-user assignment is needed before promising branch-only manager notifications; do not mistake location-tagged events for branch-scoped membership.