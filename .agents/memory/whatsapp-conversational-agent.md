---
name: WhatsApp conversational agent
description: Non-obvious rules for the LLM tool-loop WhatsApp concierge layered over the guided flow
---
- The concierge (whatsapp-agent.ts) runs BEFORE the deterministic guided flow and must always return false on any failure so legacy takes over; STOP/START, kill switch, ni_* steps, test-drive Yes/No replies, and bare menu-style tokens ("2", "yes", "skip") during a legacy step stay deterministic and are checked first. Env off-switch: WHATSAPP_CONVERSATIONAL_AGENT=off.
- **Anthropic tool loops often emit the customer-facing reply as text alongside tool_use blocks, then end with an EMPTY end_turn.** Always retain the last non-empty text across iterations and use it when the final turn has no text, or every tool-using reply degrades to the fail-safe message.
- Identity PII from the model (name/email) is only accepted if it literally appears in what the customer wrote (inbound transcript + current burst) — provenance guard against hallucinated/injected data. **Why:** model-supplied tool args are untrusted.
- Lead find-or-create is serialized per (dealerId, phone) with `pg_advisory_xact_lock(dealerId, hashtext(phone))` in a wrapper transaction; the in-memory 4s burst debounce is process-local and NOT a duplicate guard.
- Durable memory lives in whatsapp_conversations.ai_context (JSON, step="ai"); when the agent takes over a mid-flight guided convo it seeds memory from the convo columns. If the agent declines while step="ai", the flow resets step to "name" so the legacy machine has a valid step.
