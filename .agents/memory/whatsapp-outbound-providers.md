---
name: Dealer-scoped WhatsApp outbound
description: Fail-closed dealer channel resolution, opt-out enforcement, and legacy Twilio boundaries
---

Every proactive WhatsApp send must resolve an enabled channel from the message's dealership. A missing or disabled dealer channel is a delivery failure; never fall back to a process-wide sender or another dealer's credentials.

**Why:** A global provider fallback can send one dealership's customer communication from another business number. Direct sends can also bypass dealership-scoped STOP preferences and omit the customer transcript.

**How to apply:** Put customer-facing sends through the dealer-scoped outbox so channel lookup, STOP suppression, retries, and transcript recording stay together. Keep any legacy Twilio transport explicitly scoped; it is not a cross-dealer fallback.
