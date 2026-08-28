---
name: AURA authenticated screenshots
description: How to screenshot signed-in AURA pages without Clerk login
---
Appending `?test-user=<seeded email>` to any AURA dev URL activates the dev-only persona (persisted in localStorage; `?test-user=off` clears it), skipping the Clerk gate and sending x-test-user-email on every API call.

**Why:** The screenshot tool cannot complete Clerk sign-in, so authenticated UI verification is otherwise impossible.

**How to apply:** e.g. screenshot path `/feedback-forms?test-user=gm@aura-demo.com`. Dev builds only; server ignores the header in production.
