---
name: Automatic survey timing and activation
description: Forward-only activation and per-event survey semantics
---

Automatic sales/service survey rules start with completions after activation or reactivation. Do not silently backfill older customers when enabling a rule.

**Why:** Enabling automation is not approval to send a historical bulk campaign.

**How to apply:** Historical campaigns require a separate explicit action. A delay day is 24 elapsed hours (two days = 48 hours); the UI must explain this rather than implying a calendar-day send time. Sales is measured from handover once the workflow is complete; service is measured from case closure/collection, not workshop work completion. Repeat deliveries and service visits are separate survey events, not one lifetime survey per customer.
