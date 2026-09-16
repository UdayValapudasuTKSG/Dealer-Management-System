---
name: Orval and Zod 3 compatibility
description: Dependency upgrade constraint for the OpenAPI generator and generated Zod schemas
---

Keep Orval pinned to a patched 8.22.x release while the workspace uses Zod 3.

**Why:** Later Orval releases can generate Zod 4-only APIs such as `zod.int()`, which causes thousands of type errors against the workspace's Zod 3 runtime. Orval 8.22.0 fixes the known advisories while retaining the existing generated-schema contract.

**How to apply:** When upgrading Orval again, run codegen in a disposable/generated-output backup and typecheck before changing the pin; migrate the Zod dependency and generated sources together if a newer Orval is required.