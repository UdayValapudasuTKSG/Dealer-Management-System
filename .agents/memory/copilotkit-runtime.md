---
name: CopilotKit runtime integration
description: Non-obvious constraints for running CopilotKit runtime behind the Replit reverse proxy in this monorepo.
---

# CopilotKit runtime (AG-UI concierge)

CopilotKit runtime is mounted at `/api/copilotkit` in the Express api-server. The web app
wraps everything in `<CopilotKit runtimeUrl>` and renders a persistent `CopilotSidebar`.

## Client 1.62+ requires the v2 single-route runtime, not the v1 GraphQL endpoint
**Rule:** With `@copilotkit/react-*` >= 1.62, the server must mount the v2 runtime
(`createCopilotExpressHandler` from `@copilotkit/runtime/v2`, `mode: "single-route"`)
with an agent named `default`. Do NOT use the legacy `copilotRuntimeNodeExpressEndpoint`
GraphQL endpoint.
**Why:** The 1.62 `<CopilotKit>` compat wrapper defaults `useSingleEndpoint ?? true`, so
the client POSTs JSON envelopes (`{method:"info"|"run"...}`) to the runtime URL. The v1
GraphQL endpoint 400s these ("Invalid JSON payload") → a red "Runtime info request failed
with status 400" banner on every page + "Agent default not found", and chat is broken.
**How to apply:** Build the agent with `new BuiltInAgent({ model })` where model comes
from `createAnthropic({ baseURL: AI_INTEGRATIONS_ANTHROPIC_BASE_URL + "/v1", apiKey })`
(`@ai-sdk/anthropic`, same major as the runtime's dep). The AI SDK needs the `/v1`
suffix on the Replit proxy base URL; the Anthropic SDK does not.

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
