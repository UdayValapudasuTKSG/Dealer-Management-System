---
name: Dealer-specific user suspension
description: Suspension scope and safe handling of legacy account-wide suspensions.
---
User requirement: suspending a user must affect only the selected dealership, never their other dealerships.

**Why:** the old Settings action updated the shared identity and unintentionally denied access to every dealer. Historical records do not identify which dealership was originally intended.

**How to apply:** write explicit membership overrides, including reactivation. Preserve legacy suspensions as a fallback until a manager explicitly changes each membership; do not bulk-reactivate users or infer the intended original dealer. Authorization, staff eligibility, and notification selection must use the same effective membership status.
