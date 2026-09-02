---
name: Text status check constraints
description: Keep application status constants and PostgreSQL text-column CHECK constraints synchronized.
---

When adding a new lifecycle status backed by a PostgreSQL text column, update the table's existing CHECK constraint in the same idempotent migration. Changing TypeScript constants or validation schemas alone is insufficient.

**Why:** The application can type-check and start successfully while PostgreSQL rejects the new status only when the transition executes, causing a runtime 500.

**How to apply:** Inspect live constraints before rollout. Drop and recreate the named CHECK constraint with the complete old-plus-new value set, and exercise the new transition in a focused acceptance test.