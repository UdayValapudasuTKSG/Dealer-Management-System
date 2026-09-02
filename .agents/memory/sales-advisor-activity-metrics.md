---
name: Sales advisor activity metrics
description: Stable definitions for the monthly management report's lead and advisor activity figures.
---

The Sales Advisor Activity report counts leads received by lead creation date, contacts by `contactedDate`, quotes by distinct sent quote number, non-cancelled test drives by scheduled date, and conversions by committed/delivered deals created in the selected dealer-local range.

**Why:** Current lead phase and boolean summary fields are snapshots, not dated activity history. Treating them as monthly events would fabricate when work happened and make management comparisons unreliable.

**How to apply:** Keep the selected range dealership-local. Attribute activity through the related lead using `ownerUserId` first and the legacy assigned name only as a fallback; preserve Unassigned as a visible management segment.