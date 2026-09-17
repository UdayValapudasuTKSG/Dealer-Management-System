---
name: Timesheet history boundaries
description: Historical timer attribution and manual-versus-captured work policy.
---
Never infer historical daily hours or technician ownership from cumulative job-card timers or the current assignee. A pre-existing running timer without a captured opening boundary remains unallocated when stopped.

**Why:** A cumulative timer has neither historical day allocation nor reassignment evidence; assigning its remainder to today's technician fabricates history.

**How to apply:** Reconcile legacy remainder against captured work for the same card, report unknown remainder only at dealer scope, and retain opening identity/timezone for the entire segment.

Existing manual job/day entries remain authoritative when automatic work subsequently arrives; show the automatic evidence as excluded rather than deleting the manual correction or counting both.

**Why:** Manual entries may be intentional corrections and have no exact timestamps with which to infer partial overlap.

**How to apply:** Keep the exclusion visible, and prevent new same-technician/job/day manual entries once captured work exists. Unlinked manual entries are for non-timer work.