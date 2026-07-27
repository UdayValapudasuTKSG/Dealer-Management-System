---
name: Delivery advance gate evaluation
description: Body-supplied values must be folded into unmet-gate evaluation before computing gates on delivery advance.
---
The delivery advance endpoint evaluates readiness gates (`computeUnmet`) against a copy of the stored row. Any field the client can supply in the advance body that also participates in a gate (registration number, deliveredAt, signature name/data) MUST be merged onto that copy before gating.

**Why:** the signature step 422'd on valid pad submissions because the gate only saw the stored (empty) signature fields — the body value was applied after the gate check.

**How to apply:** when adding a new gated field to the advance body, set it on the `gated` copy alongside the `extra` update object in the advance handler, not just in the per-step side-data switch.
