---
name: Time-sensitive sweep priority
description: Ordering rule for scheduled reports sharing a worker with backlog-processing sweeps.
---

Run time-sensitive scheduled notifications before backlog-oriented sweep work in a shared worker pass.

**Why:** Assignment, SLA, service, or feedback backlogs can take long enough that a later report sweep never reaches its enqueue step within the expected send window, especially when a production process starts after the configured time.

**How to apply:** When adding a clock-gated report or digest to a combined worker, place its idempotent sweep before potentially unbounded backlog processing, or give it an independent execution path.