---
name: Reservation soft-locks
description: Invariants for paid-reservation inventory holds that every release/commit path must keep.
---

Rule: once a reservation invoice is fully paid, the deal's requested units are soft-locked all-or-nothing in a dedicated allocations ledger. Payment is never rolled back for a stock shortage — the deal is marked blocked ("unfulfilled") and managers are notified.

**Why:** partial holds create phantom availability, and rolling back a recorded payment loses money truth. The ledger — not bookings or deliveries — is the single claim source, so competing reservations can't double-lock a unit.

**How to apply:**
- Allocation runs after the payment commits, in its own transaction. Any allocation failure (shortage or otherwise) must persist the blocked deal state — never leave a paid reservation silently committable.
- Commitment must adopt the exact held VINs and requires a complete, unexpired active hold set; unfulfilled or lapsed holds block commitment at commit time (never rely on the lazy expiry sweep).
- Every path that returns a vehicle to available stock must consult BOTH active bookings and active reservation holds, never bookings alone; refund approval must free every formerly held VIN, not just delivery-linked ones.
- Deals with captured funds keep their holds until the refund gate approves.
