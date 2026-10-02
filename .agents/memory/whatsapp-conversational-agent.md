---
name: WhatsApp conversational agent
description: Non-obvious rules for the LLM tool-loop WhatsApp concierge layered over the guided flow
---
- The concierge (whatsapp-agent.ts) runs BEFORE the deterministic guided flow and must always return false on any failure so legacy takes over; STOP/START, kill switch, ni_* steps, test-drive Yes/No replies, and bare menu-style tokens ("2", "yes", "skip") during a legacy step stay deterministic and are checked first. Env off-switch: WHATSAPP_CONVERSATIONAL_AGENT=off.
- **Anthropic tool loops often emit the customer-facing reply as text alongside tool_use blocks, then end with an EMPTY end_turn.** Always retain the last non-empty text across iterations and use it when the final turn has no text, or every tool-using reply degrades to the fail-safe message.
- Identity PII from the model (name/email) is only accepted if it literally appears in what the customer wrote (inbound transcript + current burst) — provenance guard against hallucinated/injected data. **Why:** model-supplied tool args are untrusted.
- Lead find-or-create is serialized per (dealerId, phone) with `pg_advisory_xact_lock(dealerId, hashtext(phone))` in a wrapper transaction; the in-memory 4s burst debounce is process-local and NOT a duplicate guard.
- Durable memory lives in whatsapp_conversations.ai_context (JSON, step="ai"); when the agent takes over a mid-flight guided convo it seeds memory from the convo columns. If the agent declines while step="ai", the flow resets step to "name" so the legacy machine has a valid step.
- Inventory answers must aggregate the complete dealer-scoped available set before limiting or formatting, and every new stock/model/price question must force a fresh lookup. **Why:** a 12-row sample was once misreported as the dealership's entire stock, and a model-only follow-up reused that false conclusion.
- Customer-facing WhatsApp automation must describe availability without disclosing exact stock-unit quantities, including model/colour totals and numbers from earlier assistant replies.
  **Why:** The user explicitly requested keeping stock quantities private after a reply disclosed model and colour counts.
  **How to apply:** Keep internal inventory counts intact, but exclude quantities from customer-facing AI inputs and guided replies. Fresh full-inventory lookup is still required for accurate availability; it is not permission to disclose counts.
- A WhatsApp quote promise requires a persisted quote/email action or a durable sales follow-up; updating lead notes is not a handoff. Never describe an outbox enqueue as delivery.
  **Why:** A customer supplied an email and was promised a quote, but the bot only updated the existing lead; no quote, outbox row or staff notification existed.
  **How to apply:** Use canonical quote generation and shared per-revision email dedupe, retain approval guards, and prefer tool-confirmed wording over model-written assurances. Do not send old requests retroactively while testing a fix.
- Service confirmations and service-location answers must use the same configured dealership address as the WhatsApp showroom address, not a separate inferred workshop location.
  **Why:** The user explicitly requested the same configured dealer address in service emails and WhatsApp bot replies.
  **How to apply:** Apply the shared address resolution to email/calendar locations and WhatsApp confirmations; omit missing addresses rather than inventing one.
