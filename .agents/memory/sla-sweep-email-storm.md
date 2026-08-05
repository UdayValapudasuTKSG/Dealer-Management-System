---
name: SLA sweep email storm on imported leads
description: Bulk-imported assigned leads trigger a continuous SLA-breach email fan-out; how to suppress it durably.
---

The notification sweep escalates every lead in phase `new` with an owner set that is >24h old: 1 advisor email + one email per manager, every run. Bulk-importing thousands of historical leads and then assigning owners makes ALL of them breach at once — the queue refills continuously, so cancelling queued rows does nothing (each sweep run generates NEW distinct dedupe keys for leads it hasn't reached yet).

**Why:** After assigning ~2k imported leads to advisors, prod enqueued ~1k emails per few minutes; draining the queue just made room for the next wave.

**How to apply:**
- The email queue dedupes on a UNIQUE `dedupe_key` with `ON CONFLICT DO NOTHING` — pre-seeding `cancelled` rows with the keys the sweep would generate permanently no-ops those enqueues. Keys: `lead:sla24:breach:<leadId>:advisor` and `lead:sla24:breach:<leadId>:manager:u<userId>` (cross-join dealer users to cover the manager fan-out).
- Do this in BOTH dev and prod whenever historical leads are imported with owners, or import them with a phase/contact state that exempts them from the sweep.
- "Queue depth" = rows in status `queued` or `sending`; a lone stuck `sending` row counts too.
