---
name: Publish CHECK validation
description: Observed schema-diff serialization hazard for unvalidated PostgreSQL CHECK constraints.
---

Finish staging CHECK validation in development before publishing when existing rows satisfy the rule.

**Why:** The publish schema diff was observed serializing `pg_get_constraintdef` definitions ending in `NOT VALID` as malformed `CHECK (...)) NOT VALID)` statements. The database definitions themselves were valid. Validating the constraints preserved the predicates and records and made the regenerated diff syntactically valid.

**How to apply:** Confirm the actual development definition and freshly generated diff, count violating rows first, and use development-only `VALIDATE CONSTRAINT` if clean. Never remove checks or rewrite historical data to hide violations. Verify regenerated SQL and leave production schema changes to Publish.