---
name: Quote-PDF seed/relink tool
description: How imported Salesforce quote PDFs are linked to leads and relinked on a fresh (e.g. cloud) database.
---

- Tool: `artifacts/api-server/src/scripts/quote-documents-seed.ts` (run with any tsx, e.g. `../../scripts/node_modules/.bin/tsx`). Commands: `export` (snapshot links → `artifacts/api-server/seeds/quote-documents.seed.json`, committed) and `apply` (relink on target DB; `--pdf-dir` re-uploads missing objects).
- **Match by NAME first, contact fields only as fallback.** GT Automotive leads share placeholder emails/phones (`test1@gtautomotive.gy`) — email-first matching mislinks quotes.
- **Dedupe by fileName across the whole dealer**, not (leadId, fileName): the matcher may pick a different lead per run, so per-lead dedupe silently duplicates documents.
- Apply takes ~6+ min for ~650 entries (sequential storage `.exists()` checks) — always run via nohup+log, never a foreground ShellExec (5-min kill leaves a half-done run).
- Target DB is whatever `@workspace/db` resolves; in production it prefers `EXTERNAL_DATABASE_URL` when set.
