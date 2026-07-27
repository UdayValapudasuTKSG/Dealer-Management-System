---
name: Refund gate execution guards
description: Correctness rules for gate-authorized refunds via POST /payments
---

Rule: money never moves at gate approval — finance executes the refund as a negative payment carrying `gateId`. All money-flow guards must be race-proof at the DB layer, not just precheck:

- Stamp `gateId` on the ledger row INSIDE `applyPayment`'s transaction, never post-hoc; a partial unique index on `payments(gate_id) WHERE gate_id IS NOT NULL` makes double refunds impossible under concurrency (23505 → 409 `refund_already_recorded`).
- Validate invoice-to-gate linkage (deal gate: invoice.dealId = gate.refId; booking gate: invoice.dealId = booking.dealId) or a valid gate could reverse an unrelated invoice.
- Enforce the manager-approved cap: `abs(amount) <= gate.amount` (small cent tolerance).

**Why:** first implementation prechecked duplicates and stamped gateId after the payment tx — architect flagged a TOCTOU double-refund race plus unbounded/unlinked refunds.
**How to apply:** any future gate-authorized money movement (payout, credit, adjustment) needs the same trio: in-tx unique link, ref linkage check, approved-amount cap.
