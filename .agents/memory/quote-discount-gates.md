---
name: Quote discount gates
description: Correctness rules for the quote_discount approval flow and capacity blocks
---
- Discount request: gate insert + quote flag flip run in one tx with CAS (`status='current' AND discount_status<>'pending'`); race → 409.
- Gate approve cascade only applies when the quote is still `current`, `discount_status='pending'`, and `discount_gate_id` matches the gate — regenerating the quote silently supersedes the request (approval becomes a no-op with "no changes" receipt).
- **Why:** without the guard, approving a stale gate discounted a superseded quote while the real current quote stayed full price.
- New gate types must also be added to the Gate `type` enum in openapi.yaml or `/gates/:id/resolve` 500s on response Zod parse even though the cascade committed.
- Capacity blocks: advisor refs must be validated via dealer_users membership join, not a bare users lookup (cross-tenant IDs otherwise accepted).
- SLA dedupe keys were deliberately KEPT as `lead:sla24:*` when the SLA moved to 48h — re-keying would re-notify every previously-alerted lead (email storm).
