---
name: Per-dealer SMTP email
description: Non-obvious rules for the per-dealer SMTP connections and template overrides
---

- Outbound email is dealer-SMTP only: no Gmail/global fallback exists anymore. A dealer without a configured+enabled connection has queued email terminally `cancelled` with a "skipped" reason — never retried, never sent via another sender.
  **Why:** user-mandated strict rule (Aug 2026); mirrors the WhatsApp no-fallback policy.
- Never return, persist, or log raw SMTP error text. Server banners/auth responses can echo credential material (and a hostile configured endpoint can do so deliberately). Use `sanitizeSmtpError` (smtp-connection.ts) → fixed classified message + code; log only the code.
- The email outbox worker claims rows with an atomic compare-and-set (queued/failed→sending guarded on id+status+attempts), same as the WhatsApp worker. Any new outbox-processing path must claim before side effects or multi-process workers duplicate sends.
- The atomic claim increments `attempts` before skip decisions, so cancelled-for-no-SMTP rows end at attempts=1 (verify-smtp-email asserts ≤1).
- Non-GM roles have no `settings:view` at all, so redaction of connection details is defense-in-depth behind an RBAC 403.
- Regression suite: `pnpm --filter @workspace/scripts run verify-smtp-email` (aborts if dealers 1/2 already have real SMTP rows).
