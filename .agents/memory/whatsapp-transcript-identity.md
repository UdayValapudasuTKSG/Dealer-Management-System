---
name: WhatsApp transcript identity
description: How customer WhatsApp history is safely unified across repeat enquiries.
---

Show a repeat customer's WhatsApp transcript across all of their enquiries by matching the exact normalized phone number within the same dealership, in addition to messages explicitly linked to the viewed lead.

**Why:** A customer can open a new enquiry while their next inbound message is routed to an earlier open lead. Filtering only by `leadId` makes a valid customer message appear missing on the newer deal. Matching only a shared suffix would leak unrelated customers whose numbers happen to end alike.

**How to apply:** Any lead or deal conversation view and any reply-window calculation must use the dealer-scoped exact phone identity. Keep records explicitly attached to the current lead visible too, so a later phone correction does not hide its prior transcript.