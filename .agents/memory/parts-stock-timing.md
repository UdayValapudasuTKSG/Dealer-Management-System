---
name: Parts stock timing
description: Confirmed distinction between reservations, physical parts issuance, and billing.
---

Attaching parts to jobs/estimates reserves them. Physically issuing parts deducts on-hand stock; billing deducts only quantities not already issued. Existing issued lines remain issued.

**Why:** The user explicitly selected physical-issue timing when the Parts build brief's billing-time deduction conflicted with existing workshop issuance. Billing must never deduct the same parts twice.

**How to apply:** Route reservations, physical issues, billing, and operational returns through the same stock ledger. Preserve historical invoice/issue evidence and keep financial credits stock-neutral when physical returns already restored stock.