---
name: DB-level uniqueness + tracked migrations
description: New schema columns/constraints must ship as a tracked SQL migration and uniqueness must be enforced by an index, not app checks.
---

Rule: any new column a feature reads/writes needs an idempotent SQL file in `lib/db/migrations/` (drizzle push alone is not deployable history), and any "unique across rows" business rule needs a database unique (often partial) index — the app-level read-then-write pre-check is advisory only.

**Why:** completion code review rejected a feature that queried `dealers.meta_page_id` with no tracked migration and only an application uniqueness check; concurrent PATCHes could map one Facebook Page to two dealers, breaking deterministic tenant routing.

**How to apply:** add `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` + `CREATE UNIQUE INDEX IF NOT EXISTS ... WHERE col IS NOT NULL` in a dated migration; mirror the index in the drizzle schema; catch pg error 23505 (check both `err.code` and `err.cause.code`) and return the documented 409; verify with two concurrent requests (expect 200/409).
