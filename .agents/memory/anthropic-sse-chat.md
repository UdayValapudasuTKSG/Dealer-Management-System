---
name: Anthropic SSE chat
description: Non-obvious correctness requirements for the streaming AI chat feature (server SSE + client fetch stream).
---

# Anthropic streaming chat

The AI Concierge chat is contract-first (OpenAPI → codegen), but the send-message
endpoint (`POST /anthropic/conversations/{id}/messages`) returns an SSE stream, and
Orval generates a mutation hook that is **not usable for streaming**. Do not use it.

## Client rule
Consume the stream with `fetch` + `response.body.getReader()`. Buffer partial frames:
accumulate decoded chunks, split on the blank-line separator (`\n\n`), and keep the
trailing fragment in the buffer for the next read. Splitting each raw chunk on `\n`
and `JSON.parse`-ing lines directly **drops content** when a JSON event straddles a
chunk boundary. Use an `AbortController`, store it in a ref, and abort on unmount /
conversation switch. Capture the conversation id at send time so late invalidation
targets the right conversation.

## Server rule
Persist the assistant message in a way that survives client disconnect: track a
`persisted` flag + accumulated text, save in a shared `persist()` helper, and call it
on normal completion, on error, and from `res.on("close")`. Wire the client
disconnect to `AbortController` passed to `anthropic.messages.stream(opts, { signal })`
so generation stops (saves tokens/credits) — then swallow the resulting abort error.

**Why:** the naive version only inserted the assistant row after the loop fully
finished, so any disconnect/abort/error lost the whole reply and left the upstream
call running.

## Integration
Backed by Replit AI Integrations (Anthropic) — env `AI_INTEGRATIONS_ANTHROPIC_BASE_URL`
+ `AI_INTEGRATIONS_ANTHROPIC_API_KEY`, no user key. The system prompt injects live
dealership data (inventory/leads/deals/service); cap those lists and chat history to
bound token growth per turn.
