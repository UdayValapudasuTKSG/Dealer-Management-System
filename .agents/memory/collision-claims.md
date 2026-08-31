---
name: Collision claims module
description: Durable invariants for the collision insurance claims layer on Service & Repair
---

- Claims are a layer OVER repair orders (one claim per service order); the workshop lifecycle is untouched. **Why:** a parallel workshop system was explicitly out of scope.
- Insurer decision transitions are business sign-offs checked in-route against manager-tier roles; RBAC category stays "edit". **Why:** new RBAC categories would weaken existing role grants.
- Invariant: an "invoiced" claim is bound to exactly one live issued invoice; claim-linked invoices can never be manually voided or duplicated, and a job card carries at most one invoice (DB-enforced). **How to apply:** any new path that issues, binds, or voids a service invoice must serialize on the shared rows and re-check state after locking — check-then-write versions of these flows have produced orphaned receivables.
- Any endpoint exposing claim-linked data (including document evidence) must reuse the technician-to-assigned-order boundary, not just dealer scoping. **Why:** dealer scoping alone lets unassigned technicians enumerate accident evidence.
- Collision automation may route handoffs and reminders, but it must never execute insurer decisions or protected status transitions. **Why:** approval authority remains human and role-gated. **How to apply:** use the governed agent roster plus the existing deduplicated notification/email outbox.
- Once a collision invoice binds, its claim money, supplements, discounts, and adjustments are locked. **Why:** changing any one after split stamping desynchronizes insurer/customer receivables. **How to apply:** finalize supplements before invoicing; use settlements afterward.
