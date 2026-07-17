---
name: Multi-dealer tenancy conventions
description: How dealer scoping works in AURA and rules when adding new routes/tables.
---
Rule: every tenant-owned table has `dealer_id`; every route filters by `activeDealerId(res)` and stamps it on inserts; cross-dealer ids return 404 (never 403 — don't leak existence). `notifyUser`/`notifyUsers`/`enqueueEmail` and timeline/gate/activity/invoice inserts require `dealerId` — in libs take it from the parent record's `.dealerId`, in routes from `activeDealerId(res)`.
**Why:** strict per-dealer separation is a task requirement; a missed stamp silently leaks data across dealers and typecheck only catches inserts, not SELECT filters.
**How to apply:** when adding a new table or route, add `dealerId` to the schema + Zod, scope every select, stamp every insert, and pass dealerId through any helper signatures. Public flows derive dealer from the referenced vehicle/lead; background intake (Gmail/webhooks) defaults to CAM Motors (id 2). Scripts/seeds use `DEALER_ID = 2`.
