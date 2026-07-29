---
name: Regression suites need ephemeral fixture users
description: Why p0-security / isolation-p5 create their own dealer-2-only GM users instead of using shared demo accounts
---

Rule: tenant-isolation regression suites must create their own ephemeral test identities (user + single dealer membership, deleted in a finally block), never reuse shared demo accounts.

**Why:** the suites' "non-member → 403" checks silently broke when gm@aura-demo.com was later added as a dealer-1 member for UI browsing. Shared account memberships legitimately drift over time.

**How to apply:** when writing a check that depends on a user NOT being a member/having a role, seed a dedicated user for the run (dealer-2-only GM with the 'General Manager' role) and clean up in finally. Also: low-privilege roles 403 before the 404 tenant check fires — fixture users need view permissions on the resources under test.
