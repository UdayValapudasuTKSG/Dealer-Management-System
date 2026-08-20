---
name: Vehicle VIN uniqueness
description: Why active vehicle VIN uniqueness is enforced at runtime until historical production duplicates are reconciled.
---

Treat nonblank active VINs as case-insensitive, whitespace-trimmed, and unique within a dealership.

**Why:** A production audit found historical normalized duplicates, so adding a database unique index immediately would fail during publish. Runtime locking and collision checks protect new writes but do not repair old data.

**How to apply:** Before adding a database constraint, audit every environment and reconcile historical duplicates through an approved data fix. Scope any eventual partial unique index by dealership and exclude deleted or blank VINs.