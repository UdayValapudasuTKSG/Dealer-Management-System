---
name: Agent-run idempotency ledger
description: Using agent_runs as a per-input idempotency ledger requires a stable refType/refId key.
---
Rule: when an agent uses its own `agent_runs` rows as the "already processed this input?" ledger, every outcome path must record the SAME refType/refId (the triggering input, e.g. the call log) — put downstream entities in `affectedEntities` instead.

**Why:** an outcome path that overrode refType to the lead made the ledger lookup (keyed on the call) miss the prior run, so a webhook/transcription retry re-ran the agent and re-messaged the customer (outbox dedupeKeys were the only thing preventing duplicates).

**How to apply:** any recordAgentRun-based dedupe — keep runType + refType/refId constant across all branches of the handler; check the ledger before any side effect.
