---
name: CopilotKit runtime integration
description: Non-obvious constraints for running CopilotKit runtime behind the Replit reverse proxy in this monorepo.
---

# CopilotKit runtime (AG-UI concierge)

CopilotKit runtime is mounted at `/api/copilotkit` in the Express api-server, using
`AnthropicAdapter` over the Replit-managed Anthropic client (no own key). The web app
wraps everything in `<CopilotKit runtimeUrl>` and renders a persistent `CopilotSidebar`.

## Streaming is cut by the proxy unless you disable buffering
**Rule:** On the copilotkit endpoint you MUST set `Cache-Control: no-cache, no-transform`
and `X-Accel-Buffering: no` on the response before handing off to the runtime handler.
**Why:** The runtime streams its GraphQL response incrementally (chunked). The Replit
reverse proxy buffers/transforms it by default, so the terminating chunk never reaches
the browser — you get `ERR_INCOMPLETE_CHUNKED_ENCODING` + "network error" / "Error
generating suggestions" on the client, even though the api-server logs a clean 200 with
a multi-second responseTime. The old `/anthropic` SSE path avoided this because
`text/event-stream` is auto-recognized as non-bufferable; CopilotKit's content type is not.
**How to apply:** Set the two headers in the Express wrapper for `/copilotkit`. If chat
or suggestions silently fail with a network error but the server shows 200, this is it.

## Express mount strips the prefix; the runtime needs the full path
**Rule:** In the wrapper, set `req.url = req.originalUrl` before calling the handler.
**Why:** Express strips the mount prefix from `req.url`; the runtime's internal router
(Hono/Yoga basePath) expects the full `/api/copilotkit` path or it 404s the operation.

## Skip Express body parsing for the copilotkit path
**Rule:** Do not run `express.json()` / `express.urlencoded()` on `/api/copilotkit`.
**Why:** The runtime reads the raw request stream itself; a body parser drains the
stream first and the runtime hangs.

## opentelemetry peer split (pnpm strict layout)
**Rule:** `@opentelemetry/api` must be a direct dep of every package that transitively
loads drizzle-orm alongside CopilotKit (lib/db, scripts, AND api-server).
**Why:** CopilotKit pulls `@opentelemetry/api`; without pinning one version across these
packages, pnpm's strict layout resolves duplicate instances and drizzle-orm throws a
duplicate-instance TS/runtime error. api-server needs it directly because its build
externalizes `@opentelemetry/*`, so it must resolve at runtime.
