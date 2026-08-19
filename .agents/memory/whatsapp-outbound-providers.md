---
name: Dealer-scoped WhatsApp outbound
description: Fail-closed dealer channel resolution, opt-out enforcement, and legacy Twilio boundaries
---

Every proactive WhatsApp send must resolve an enabled channel from the message's dealership. A missing or disabled dealer channel is a delivery failure; never fall back to a process-wide sender or another dealer's credentials.

**Why:** A global provider fallback can send one dealership's customer communication from another business number. Direct sends can also bypass dealership-scoped STOP preferences and omit the customer transcript.

Meta request outcomes must distinguish definite rejection from uncertainty. Retry only a definite provider rejection; a timeout, 5xx, or malformed success response may already have delivered and must wait for its correlated receipt instead of being resent. Delivery-state transitions must be conditional database writes, not read-then-write checks, so concurrent receipts cannot regress delivered/read.

**Why:** A lost HTTP response after Meta accepts can otherwise produce a duplicate customer message. Concurrent failed/delivered receipts can also both pass an application-level precheck and overwrite each other.

**How to apply:** Put customer-facing sends through the dealer-scoped outbox so channel lookup, STOP suppression, request correlation, and transcript recording stay together. Include a stable opaque outbox correlation value in provider requests; terminally fail stale unknown outcomes without automatic resend. Fail closed for Twilio WhatsApp unless the receiving sender number has an explicit dealer mapping.
