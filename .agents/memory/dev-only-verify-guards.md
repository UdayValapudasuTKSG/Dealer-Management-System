---
name: Dev-only verify guards
description: Isolation rules a fixture-creating verify suite must satisfy to pass completion code review.
---
Rule: a verify suite that seeds DB fixtures and exercises notification/email paths must be provably unable to touch non-fixture data: allowlist the database target (dev host only — not NODE_ENV or string-equality checks), run the guard before any DB-opening module loads (ESM static imports hoist, so use dynamic imports), scope any global sweep under test to fixture dealer ids via an explicit seam, and suppress the global outbox worker in-process (enqueue helpers kick it, and it scans ALL dealers' queued mail).

**Why:** completion code review rejects suites that could run against production, enqueue mail for real dealers, or trigger sends of unrelated queued emails on the shared dev DB — each of these was a separate rejection.

**How to apply:** when writing a new verify-* script, mirror the guard + seams in the lead-source-report suite rather than inventing weaker checks.
