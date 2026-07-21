---
name: Agent kill switches fail open per dealer
description: Per-dealer agent kill switches only work when the dealer has seeded agents rows
---

The per-dealer agent kill switch (`isAgentEnabled`) fails OPEN when the dealer has no row in `agents` for that key — deliberate, so un-seeded dealers keep working.

**Why:** during verification, pausing "sales" for dealer 1 had no effect because only dealer 2 had seeded agent rows; the LLM call went through anyway.

**How to apply:** when adding a dealer or a new agent key, seed `agents` rows for EVERY dealer (copy from an existing dealer) or the pause toggle silently does nothing. Use `strict: true` where a paused/idle agent must never run.
