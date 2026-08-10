---
name: pg pool idle-error crashes strand mid-flow work
description: Symptom pattern — records created but their synchronous follow-up steps (assignment, notifications) missing in prod.
---

Hosted Postgres (Neon) drops idle connections; without a `pool.on("error")` listener the whole api-server process crashed on ECONNRESET, killing in-flight multi-step flows (e.g. intake lead inserted but never round-robin assigned).

**Why:** Two prod gmail-intake leads sat unowned; deployment logs at the exact created_at showed "artifact process exited / crash loop", not an assignment error.

**How to apply:** When a prod record exists but its synchronous side effects are missing, check deployment logs at the record's created_at for a crash before hunting logic bugs. Guards now in place: pool error listener in lib/db and an unassigned-lead catch-up sweep in notification-sweeps — keep both when refactoring.
