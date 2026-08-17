---
name: Test-drive capacity planning
description: Non-obvious rules for capacity blocks (hour frame, model-wide vehicle blocks, date serialization)
---

- **Slot hour frame**: test-drive slots are generated with `new Date(y,m,d,hour)` (server-local wall clock, server runs UTC). Hour-window blocks must compare via `start.getHours()`, NOT an America/Guyana Intl conversion — mixing frames silently misses every slot.
- **Vehicle blocks are model-wide**: the planner shows ONE representative demo unit per make+model, so enforcement must match blocks against ALL units of the model (no status filter — the representative can be reserved/sold later). Filtering siblings to `status='available'` silently un-blocks.
- **Date round-trip**: SQL `date` serializes as UTC midnight; in UTC-4 UIs use the ISO date part (`toISOString().slice(0,10)`), never local getters, or the grid shifts a day.
- **Generated query params**: `format: date` query params codegen to `zod.date()` (no coerce); Express delivers strings — coerce to Date in the route before safeParse or every filtered GET 400s.
- Capacity routes are gated on the `settings` module (view for GET, edit for writes).
