---
name: Clerk + RBAC testing on this project
description: Lessons for e2e-testing Clerk-authed RBAC flows and keeping headless validation harnesses working after adding auth.
---

- The Playwright testing subagent supports `testClerkAuth: true` for fully programmatic Clerk sign-in — describe WHO to sign in as, never script Clerk's UI. Long multi-step plans (10+ steps incl. sign-out) can exceed the 600s code_execution timeout; keep plans short and split flows across runs.
- **Why:** a 12-step plan timed out with the result lost; two focused 5–6 step runs passed quickly.
- Adding global auth middleware breaks any self-contained validation harness that curls the API (e.g. gate-cascade check). Use a dev-only `AUTH_BYPASS=1` env var (guarded by `NODE_ENV !== "production"`) that injects a synthetic full-permission user.
- **How to apply:** whenever adding new headless scripts/validations that hit protected routes, run them with `AUTH_BYPASS=1`.
- JIT provisioning means dev DB user rows only appear after first browser sign-in. (First-user-becomes-GM auto-role is RETIRED — new users start with no dealer membership; only the SUPER_ADMIN_EMAIL is special.)
- New/reset dev databases have EMPTY roles tables — every user then gets 403 on all modules even after manual role assignment. Run the RBAC seed script first, then assign roles, then wait out the 15s permission cache.
- **Why:** an e2e run failed twice with 403s on /api/customers; the cause was an unseeded roles/role_permissions table in a fresh task environment, not the new feature code.
- The AUTH_BYPASS synthetic user's id does NOT exist in the users table — any route that writes `user.id` into a FK column (created_by, author, assignee) must first verify the row exists and fall back to null, or inserts 500 under the harness.
- **Why:** task creation failed with an FK violation only when exercised via the bypass harness; real Clerk sessions always have a provisioned row.
