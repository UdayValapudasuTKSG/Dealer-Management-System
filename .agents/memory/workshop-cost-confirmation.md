---
name: Workshop cost confirmation
description: Customer approval boundaries, diagnostic preparation, and operational versus financial returns
---
Customer-cost confirmation must not prevent intake or diagnostic work needed to prepare an estimate. Once a positive customer-pay estimate exists, continuing chargeable work requires confirmation of that exact version, not a staff-entered approval flag.

**Why:** Requiring an estimate before any work creates a circular workflow; permitting work after a quoted-price change exposes customers to charges they did not accept.

**How to apply:** Review alternate work paths (timers, rollover, receipt-driven resume, completion) whenever approval rules change, rather than guarding only the main Start Work button.

Quote preparation, customer authorization, and staff confirmation of receipt are three separate steps. Preparing or changing a quote must not automatically email draft prices; staff explicitly sends the reviewed itemized quote. Customer authorization cannot be fabricated by the staff receipt action.

**Why:** The requested workshop workflow requires both the customer's consent and the dealership's acknowledgment that it has received that consent. An internal approval flag or an automatically queued total-only email does not satisfy that process.

**How to apply:** Keep the two actors' evidence separate and version-bound; require both before chargeable work resumes, and distinguish queued delivery from sent email or customer receipt.

Quote supersession must serialize with the sender's final validity check through provider hand-off, not merely cancel queued mail.

**Why:** An active worker can already have claimed a message and passed its validity check when a revised price commits. Cancelling only pending rows leaves a stale quote deliverable despite its invalidated token.

**How to apply:** Coordinate repricing and quote transport on the same job identity; use bounded transport timeouts and prevent late worker results from overwriting cancellation. Exercise the claimed-message race with fake transport.

Stock returns and financial credits are separate effects. A financial credit must not move stock again or initiate a cash refund; paid-invoice credits remain customer credit unless a separate authorized refund process is used.

**Why:** A returned issued part already restores operational stock. Sending a stock-updating accounting return would restore it twice, while silently refunding cash exceeds the workshop's authority.

**How to apply:** Keep ERPNext financial returns stock-neutral and retain the original issued document and an explicit adjusted balance.