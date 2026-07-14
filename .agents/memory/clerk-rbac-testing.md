---
name: Clerk + RBAC testing on this project
description: Lessons for e2e-testing Clerk-authed RBAC flows and keeping headless validation harnesses working after adding auth.
---

- The Playwright testing subagent supports `testClerkAuth: true` for fully programmatic Clerk sign-in — describe WHO to sign in as, never script Clerk's UI. Long multi-step plans (10+ steps incl. sign-out) can exceed the 600s code_execution timeout; keep plans short and split flows across runs.
- **Why:** a 12-step plan timed out with the result lost; two focused 5–6 step runs passed quickly.
- Adding global auth middleware breaks any self-contained validation harness that curls the API (e.g. gate-cascade check). Use a dev-only `AUTH_BYPASS=1` env var (guarded by `NODE_ENV !== "production"`) that injects a synthetic full-permission user.
- **How to apply:** whenever adding new headless scripts/validations that hit protected routes, run them with `AUTH_BYPASS=1`.
- JIT provisioning means dev DB user rows only appear after first browser sign-in; "first user → admin role" logic makes test ordering matter (sign in the admin persona first).
