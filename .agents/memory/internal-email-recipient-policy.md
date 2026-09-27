---
name: Internal email recipient policy
description: Recipient customization is separate from in-app notifications and customer correspondence.
---

Treat recipient overrides as dealership-scoped policy for automated internal emails only. Preserve original routing until an administrator explicitly customizes a type; an explicitly empty list means send to nobody, not fall back to managers.

**Why:** The requested control is to keep unwanted SLA/new-lead and other staff alerts out of individual managers' inboxes, without suppressing their in-app notifications or changing customer correspondence.

**How to apply:** Maintain this separation for new notification types. Selected staff still need module visibility. Recheck pending automated emails against current policy, but distinguish intentional manual/test sends using server-owned metadata. Resetting defaults must not replay a backlog or retain old custom recipients.