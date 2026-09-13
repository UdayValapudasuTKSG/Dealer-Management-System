---
name: pg pool idle-error crashes strand mid-flow work
description: Symptom pattern — records created but their synchronous follow-up steps (assignment, notifications) missing in prod.
---

Hosted Postgres (Neon) drops idle connections; without a `pool.on("error")` listener the whole api-server process crashed on ECONNRESET, killing in-flight multi-step flows (e.g. intake lead inserted but never round-robin assigned).

**Why:** Two prod gmail-intake leads sat unowned; deployment logs at the exact created_at showed "artifact process exited / crash loop", not an assignment error.

**How to apply:** When a prod record exists but its synchronous side effects are missing, check deployment logs at the record's created_at for a crash before hunting logic bugs. Guards now in place: pool error listener in lib/db and an unassigned-lead catch-up sweep in notification-sweeps — keep both when refactoring.

Timer-driven async work also needs a catch around the entire pass, not only individual records, and a single-flight guard that resets in finally.

**Why:** A production database authentication timeout rejected the reminder candidate query outside its per-record catch. Fire-and-forget invocation turned that rejection into an API crash loop; the pool's idle-error listener cannot catch query promise rejections.

**How to apply:** Test initial-query failure as well as per-record failure. Bound pool acquisition waits without imposing a global statement timeout on financial transactions. Crash containment does not establish that the production database connection has recovered.
