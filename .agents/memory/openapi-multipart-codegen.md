---
name: OpenAPI multipart uploads vs Orval/Zod codegen
description: How to declare file-upload endpoints in openapi.yaml without breaking api-zod codegen
---

Declaring a typed binary schema (`type: string, format: binary`) in a `multipart/form-data` request body breaks the `@workspace/api-zod` codegen — Orval emits Zod schemas referencing `File`/`Blob`, which fail typecheck in the Node lib.

**Why:** the generated Zod package is compiled for Node where DOM `File`/`Blob` types aren't available; Orval has no clean escape hatch per-endpoint.

**How to apply:** for upload endpoints, declare the request body as `multipart/form-data` with an EMPTY object schema (`{}`) in `lib/api-spec/openapi.yaml`, skip the generated mutation hook, and call the endpoint from the client with a raw `fetch` + `FormData` + `credentials: "include"`. Parse the multipart on the server with multer (memory storage) and validate fields with the existing generated body schemas per row/field. Precedent: `POST /vehicles/import`.
