---
name: ERP queue cross-dealer fairness
description: Healthy dealers can wait behind retries for an unreachable ERP site.
---
An enabled ERP connection is not necessarily reachable. Global oldest-first batches can be monopolized by a different dealer's large failing backlog, leaving approved POS jobs unattempted.

**Why:** A dummy sale remained queued with zero attempts while production logs showed repeated network failures on older jobs for another dealer. Targeted execution of the existing approved request succeeded after opening stock was prepared.

**How to apply:** Diagnose queue age and attempts separately from posting errors. Future scheduling changes need bounded per-dealer fairness or connection backoff, while retaining CAS claims, independent Finance approval, exact-target checks and existing financial holds. Do not disable other dealers or replay held queues to accelerate one sale.
