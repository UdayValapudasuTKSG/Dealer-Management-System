---
name: OpenAPI dates with Orval Zod
description: Date-body coercion and date-query parsing constraints in the generated API validators.
---

# OpenAPI dates with Orval Zod

Use different OpenAPI date representations at body and query boundaries:

- A Drizzle column declared `date(..., { mode: "string" })` expects a string, while Orval-generated body validators may coerce `format: date` or `date-time` values into JavaScript `Date` objects.
- An HTTP query parameter declared as `format: date` can generate `zod.date()`, which rejects the raw `YYYY-MM-DD` string Express receives before route code can normalize it.

**Why:** Body coercion causes type/write mismatches, while query coercion makes valid date filters fail with `Expected date, received string`.

**How to apply:** Normalize generated body dates to `YYYY-MM-DD` before Drizzle writes. For date-only query parameters, use a string schema with a `YYYY-MM-DD` pattern, then validate and compare normalized strings in the route.
