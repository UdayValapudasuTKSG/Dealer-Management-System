---
name: Orval inline body collision & index.ts quoting
description: Why new request bodies must be named component schemas, and why lib/api-zod/src/index.ts must use single quotes
---

**Rule 1:** Never add an inline `requestBody` object schema to openapi.yaml. Orval generates both a zod const (`<Op>Body` in api.ts) and a TS type of the same name in generated/types/, and the star re-exports in api-zod's index.ts then fail with TS2308. Always `$ref` a named schema under components (e.g. `GenerateQuoteInput`) like every other endpoint.

**Rule 2:** Orval workspace mode appends `export * from './generated/...'` lines to index.ts if it doesn't find them verbatim — it uses single quotes. If index.ts uses double quotes, every codegen run appends duplicates and typecheck breaks. Keep `lib/api-zod/src/index.ts` single-quoted.

**How to apply:** when editing lib/api-spec/openapi.yaml request bodies, add a component schema + `$ref`; after codegen failures with "already exported a member", check index.ts for duplicated export lines.
