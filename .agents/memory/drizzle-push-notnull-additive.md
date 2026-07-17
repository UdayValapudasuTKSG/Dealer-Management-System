---
name: Drizzle push NOT NULL columns need additive pre-migration
description: How to apply schema pushes that add NOT NULL columns to populated tables without data loss or TTY prompts
---

Rule: when a schema change adds a NOT NULL column (no default) to tables that already have rows, `drizzle-kit push` demands an interactive confirmation and offers to TRUNCATE. In non-TTY contexts (post-merge scripts, agents) it just fails, leaving the DB behind the code and crashing the server.

**Why:** the multi-dealer migration added `dealer_id NOT NULL` to ~36 populated tables; the post-merge push died on the TTY prompt and the API server 500'd on missing tables/columns.

**How to apply:** pre-migrate additively with plain SQL — `ADD COLUMN` nullable → `UPDATE` backfill → `SET NOT NULL`, create new tables/indexes manually matching the drizzle names (constraint names matter: inline `UNIQUE` creates `<table>_<col>_key` but drizzle expects `<table>_<col>_unique`; rename it) — then run `pnpm --filter @workspace/db run push`, which applies cleanly with no destructive diff. Afterwards re-run the RBAC/persona seeders if roles were touched.
