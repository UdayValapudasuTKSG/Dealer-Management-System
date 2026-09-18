---
name: Workshop cost confirmation
description: Customer approval boundaries, diagnostic preparation, and operational versus financial returns
---
Customer authorization is optional for workshop operations, including technician timers, hour capture, work progression, and resuming authorization-held jobs. Repricing invalidates prior consent evidence but must not itself stop work. Exact-version customer authorization and staff receipt remain required for invoice issuance.

**Why:** The user explicitly changed the earlier mandatory-work-authorization policy because service bookings were stuck on hold and technicians could not log hours. This relaxes operational work, not financial issuance or truthfulness of approval records.

**How to apply:** Review alternate work paths (timers, rollover, parts-receipt-driven resume, completion) whenever approval rules change, rather than guarding only Start Work. Do not auto-start existing held timers, backfill hours, or fabricate customer approval to unlock work.

Quote preparation, customer authorization, and staff confirmation of receipt are three separate steps. Preparing or changing a quote must not automatically email draft prices; staff explicitly sends the reviewed itemized quote. Customer authorization cannot be fabricated by the staff receipt action.

**Why:** Optional work authorization does not make staff receipt equivalent to customer consent. An internal approval flag or automatically queued total-only email does not prove customer approval.

**How to apply:** Keep the two actors' evidence separate and version-bound; require both for invoice issuance, not for technician work. Distinguish queued delivery from sent email or customer receipt.

Quote supersession must serialize with the sender's final validity check through provider hand-off, not merely cancel queued mail.

**Why:** An active worker can already have claimed a message and passed its validity check when a revised price commits. Cancelling only pending rows leaves a stale quote deliverable despite its invalidated token.

**How to apply:** Coordinate repricing and quote transport on the same job identity; use bounded transport timeouts and prevent late worker results from overwriting cancellation. Exercise the claimed-message race with fake transport.

Stock returns and financial credits are separate effects. A financial credit must not move stock again or initiate a cash refund; paid-invoice credits remain customer credit unless a separate authorized refund process is used.

**Why:** A returned issued part already restores operational stock. Sending a stock-updating accounting return would restore it twice, while silently refunding cash exceeds the workshop's authority.

**How to apply:** Keep ERPNext financial returns stock-neutral and retain the original issued document and an explicit adjusted balance.