---
name: Workshop oil stock and billing
description: Why oil quantities are separate from countable parts and physical returns from invoice credits.
---

Keep bulk oil quantities fractional in litres without converting countable parts to fractional stock.

**Why:** Workshop oil is dispensed in quantities such as 4.5 L, but existing purchasing and ordinary parts workflows assume whole units.

**How to apply:** Preserve decimal precision through requests, physical issue, and invoice snapshots. A request reserves availability; physical issue deducts stock; invoicing must not deduct again. A physical return after invoicing restores stock but does not imply a customer credit—use the separately authorized financial adjustment.