---
name: Generated payload casts
description: Why mutation payloads must be typed against the generated OpenAPI types, never cast with `as never`/`as any`.
---

Rule: when calling a generated Orval mutation hook, type the payload against the generated request type (e.g. `LeadUpdate`) and cast individual enum values (`v as LeadUpdate["source"]`) — never cast the whole payload `as never` / `as any`.

**Why:** A whole-payload cast disables exactly the contract check that catches drift. Inline editors PATCHed fields that were missing from the update schema in openapi.yaml; the server's generated Zod parser silently stripped the unknown keys, producing an empty object, and Drizzle's `db.update().set({})` threw "No values to set" → 500. Typecheck passed the whole time because of the cast.

**How to apply:** If the payload doesn't typecheck, the fix is to add the field to the OpenAPI schema and re-run codegen — not to widen the cast. Symptom to recognize: a PATCH that 500s with "No values to set" means every key in the body was stripped by Zod (field missing from the request schema).
