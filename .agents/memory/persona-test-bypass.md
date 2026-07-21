---
name: Dev persona test bypass
description: How to test the AURA web app as any seeded user without Clerk sign-in (dev only)
---

# Dev-only persona impersonation

- Server: outside production (`NODE_ENV !== "production"`), an `x-test-user-email` request header signs the request in as that seeded user with their REAL role/memberships/permissions (in `requireAuth`, before the AUTH_BYPASS synthetic-admin path). Unknown email → 401. Normal Clerk auth is untouched when the header is absent.
- Web client: open any app URL with `?test-user=<email>` (dev builds only) — this persists the email in localStorage (`aura-test-user-email`), skips the Clerk `<Show when="signed-in">` gate, and attaches the header to every API call (customFetch) and to CopilotKit. `?test-user=off` clears it.

**Why:** e2e Clerk sign-in flows via testClerkAuth kept hitting the 600s timeout; persona-by-header lets screenshots/curl verify role-scoped UI instantly.

**How to apply:** screenshot `/command-center?test-user=<seeded user email>` using any email from the `users` table (query the DB for seeded personas per dealer/role). CopilotKit `info` handshake 400/405 toast is pre-existing noise, not an auth failure.
