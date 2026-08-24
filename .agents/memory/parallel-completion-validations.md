---
name: Parallel completion validations
description: Why validation suites that mutate shared database fixtures must coordinate even when each suite passes alone.
---

Completion validation commands can run concurrently. Any suites that temporarily mutate the same dealership, global policy, or other shared fixture must use isolated fixtures or a shared database advisory lock.

**Why:** Sequential manual runs passed, while completion validation intermittently returned tenant-lock responses because one security suite temporarily suspended the same dealership another isolation suite was testing.

**How to apply:** When a validation passes alone but fails only in the completion runner, inspect other configured validation commands for overlapping fixture mutations before weakening assertions or adding retries.
## Cross-suite impersonation-grant contamination
p0-security creates 60-minute impersonation grants (read_only + elevated) for the shared super-admin fixture user. Any later suite asserting "super admin without grant → 403" (e.g. isolation-p5 N20) will see 201/200 while those grants are active. verify-isolation-p5 now expires the SUPER user's active grants right before N20 — keep that guard when adding similar grant-less assertions.
Also: suites hitting http://localhost:80/api return blanket 502s if run while the api-server workflow is rebuilding — restart suites only after the server is confirmed serving.
