---
name: Lead archive and deal-link serialization
description: Concurrency and restoration semantics for manager-approved lead archival.
---

Lead archival and every workflow that links operational work to a lead must serialize as one shared decision. An archived lead cannot accept new active work.

**Why:** Protecting only the work visible at archive start leaves a race where concurrent links, payments, or delivery completion can invalidate cleanup and vehicle-release decisions.

**How to apply:** New lead-linked workflows must participate in the same serialization rule and require the lead to be active. Restoring visibility must not silently resurrect closed work, holds, or stale approvals.