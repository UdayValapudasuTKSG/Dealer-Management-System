---
name: Post-merge schema drift breaks platform validations
description: Validation suites 500 on dealer create/lifecycle when a merged task's schema column was never applied to the dev DB.
---

The rule: when validation workflows (isolation-p5, provisioning-saga) suddenly fail with 500s on dealer creation/lifecycle, suspect **schema drift** — a column present in `lib/db/src/schema/*` but missing from the dev database — before suspecting your own changes.

**Why:** task merges land schema code without applying it to the shared dev DB (e.g. `dealers.parts_markup_percent` existed in code but not in the DB, so every `insert into dealers` 500'd, cascading into all lifecycle checks). The drizzle error only shows the failed SQL; the true cause (`column ... does not exist`) is in `err.cause`, easiest to see by reproducing the insert in a small tsx script.

**How to apply:** diff code schema vs `\d <table>` for the failing table, then apply the missing column additively via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ... DEFAULT <schema default>` (match the default in the drizzle schema exactly). No server restart needed.
