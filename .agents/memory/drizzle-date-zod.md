---
name: Drizzle date-mode-string + Zod coercion mismatch
description: Why date columns break inserts when bodies come from Orval-generated Zod schemas.
---

# Drizzle date(mode:"string") + Zod coercion

- A Drizzle column declared `date(..., { mode: "string" })` expects a `string` on insert/update, but Orval/Zod generated bodies coerce OpenAPI `format: date` (or date-time) fields into JS `Date` objects.
- **Why:** Typecheck fails ("Date not assignable to string") and, if bypassed, the DB write can misbehave.
- **How to apply:** Before insert/update, convert the value to `YYYY-MM-DD` (e.g. `value instanceof Date ? value.toISOString().slice(0,10) : String(value).slice(0,10)`). Handle the optional case on updates (only override when present).
