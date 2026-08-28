---
name: Vehicle interests are specifications
description: Product rule separating a customer's requested vehicle configuration from physical inventory allocation
---

Lead vehicle interests represent make, model, year, variant, color, quantity, and quoted unit price. They must never select, reserve, hold, or mutate a physical inventory unit.

**Why:** The user confirmed the original workflow intentionally showed “Unit/VIN — Assigned at allocation.” A lead records customer intent; attaching a VIN early misrepresents availability and prevents quantity-based fulfillment.

**How to apply:** Keep lead, quote, and deal commercial snapshots specification-based. Allocate distinct matching same-dealer VINs atomically only when the deal commits, including finance-driven commitment; insufficient stock must leave no partial allocations.

Lead creation with priced vehicle interests must also generate and automatically queue the canonical aggregate quote for delivery. A quote counts as sent only after SMTP or the messaging provider confirms success, never merely when queued.

**Why:** A generated-but-undelivered quote left the lead checklist looking complete while the customer received nothing.

**How to apply:** Make lead-created quote generation and its outbox key idempotent, update quote/lead sent state atomically on confirmed delivery, and auto-desk negotiation from the frozen quote without projecting or reserving a VIN.