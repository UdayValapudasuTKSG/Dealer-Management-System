---
name: Server output Zod validation
description: List endpoints validate every returned row against Zod, so bad seed data 500s the whole endpoint
---

The Express API validates response payloads against the generated Zod schemas before sending. For list endpoints this means EVERY row is validated; a single row with an out-of-range value makes the entire endpoint return 500 (`ZodError: invalid_enum_value`), even though a single-row endpoint for the same record may succeed.

**Concrete example:** customer `loyaltyTier` enum is only `["new","silver","gold","platinum"]`. A seeded customer with `"returning"` made `GET /api/customers` 500 while `GET /api/customers/:id/overview` still worked.

**Why:** contract-first output validation is strict; seed/scripts are not type-checked against the enum at insert time.

**How to apply:** when a list endpoint 500s but a detail endpoint works, suspect a single bad row failing output validation. Read the ZodError body (it names the offending field/value), fix the DB row AND the seed source so it doesn't recur.

**Seed-time guard:** DB columns are plain `text()`, so drizzle-zod insert schemas do NOT enforce the API enums by default. The enum values were re-declared as `createInsertSchema(table, { col: z.enum([...]) })` refinements (customers/timelineEvents/gates), and `scripts/src/seed-connectivity.ts` `.parse()`s every row before insert so a bad enum fails loudly at seed time, not at request time. If you add new seed enum fields, refine the matching insert schema too — the enum lives in `lib/api-spec/openapi.yaml` as the source of truth.
