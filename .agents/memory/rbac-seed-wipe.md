---
name: RBAC roles seed can get wiped
description: Empty roles table makes every authenticated request 403; re-seed after drizzle push sessions.
---

If ALL authenticated API requests suddenly return 403 (even dashboard/view for existing users), check the `roles` table first — a `drizzle push` / schema session can wipe the seeded roles, and FK `on delete set null` leaves every `users.role_id` NULL, meaning zero permissions for everyone.

**Why:** Happened mid-task: e2e tests failed with blanket 403s; the roles table was empty and all users had NULL role_id.

**How to apply:** Run `pnpm --filter @workspace/scripts run seed-rbac`, then restore `users.role_id` (first user → General Manager, others → Sales Advisor). Also remember the 15s server-side permission cache: after promoting a test user in the DB, wait ~20s before reloading, or the old (or empty) permission set is still served.
