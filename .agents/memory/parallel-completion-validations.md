---
name: Parallel completion validations
description: Why validation suites that mutate shared database fixtures must coordinate even when each suite passes alone.
---

Completion validation commands can run concurrently. Any suites that temporarily mutate the same dealership, global policy, or other shared fixture must use isolated fixtures or a shared database advisory lock.

**Why:** Sequential manual runs passed, while completion validation intermittently returned tenant-lock responses because one security suite temporarily suspended the same dealership another isolation suite was testing.

**How to apply:** When a validation passes alone but fails only in the completion runner, inspect other configured validation commands for overlapping fixture mutations before weakening assertions or adding retries.