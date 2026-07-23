---
name: Payment & gate guard atomicity
description: Concurrency conventions for invoice payment posting and gate resolution.
---

Rule: monetary guards (overpayment, reversal floor, duplicate reference) must run INSIDE the payment transaction while holding a `FOR UPDATE` lock on the invoice row; duplicate-reference checks additionally take a `pg_advisory_xact_lock` keyed on (dealerId, reference). Gate resolution must be compare-and-set (`WHERE status='pending'` in the UPDATE) — a null row means a concurrent resolve won, and the cascade must be skipped.

**Why:** pre-transaction checks are TOCTOU — an architect review found concurrent payment posts could overpay or slip duplicate references, and concurrent gate resolves could double-apply cascades and write duplicate receipts. Duplicates can't be a DB unique index because confirmDuplicate legitimately allows repeats.

**How to apply:** any new guard on payments/invoices goes into `applyPayment`'s transaction (throw `PaymentGuardError`, mapped to HTTP in the route); any new gate mutation path must keep the pending-status predicate in its UPDATE.
