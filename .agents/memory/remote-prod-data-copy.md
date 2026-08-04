---
name: Remote prod data copy
description: How to move bulk data into the Replit-managed production (Neon) database without timing out.
---

Per-row insert scripts are too slow against the remote production DB and background processes don't survive.

**Why:** The prod DB (Neon, us-east) has high per-statement latency — a ~5k-row per-row import ran >1h without committing. ShellExec kills foreground runs at 5 min, and nohup/setsid background processes silently die when the workspace/shell session recycles (a `pgrep -f` poll also self-matches the polling command — verify with `ps` output, not counts).

**How to apply:** For seeding/migrating data into prod:
1. Prefer bulk `\copy` per table: export from dev with an explicit column SELECT (null out dev-only FKs like `owner_user_id`), then `\copy ... FROM` on prod inside one transaction, then `setval` each sequence to max(id).
2. Check ID-collision safety first (dev min(id) for the tenant > prod max(id)) and that column lists match.
3. If a script must run, batch inserts (500-row chunks) so it fits the 5-min foreground window.
Prod writes need the user-provided connection string (Database pane → Production → Settings); agent SQL tools are read-only in prod.
