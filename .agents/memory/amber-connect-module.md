---
name: Amber Connect module conventions
description: Opt-in (default-off) entitlement semantics and the provider-contract boundary for the Amber telematics module.
---

## Default-off entitlements
`amber_connect` is the first OPT-IN entitlement: a missing key means DISABLED (legacy entitlement flags are deny-list, where missing = enabled).
**Why:** the module must stay off for all new and existing dealers until a super admin explicitly enables it.
**How to apply:** always resolve opt-in modules through the shared `isEntitlementEnabled` helper and keep its client-side mirrors (AURA and Realm each carry a default-off list) in sync. Never test `flags[key] !== false` directly for opt-in modules.

## Provider contract boundary
No Amber API endpoints, payloads, auth, or signatures may be invented — partner documentation is pending.
**How to apply:** all live provider calls go through a registered adapter; while none is registered, connection tests and syncs report `pending_contract` and perform no network I/O. The inbound signed webhook is AURA's own seam, not an Amber contract.

## Concurrency lessons
- Adding a value to a permission-module enum requires updating the OpenAPI enum too, or `/auth/me` 500s for every user whose role has the new grant (server output is Zod-validated).
- Read-then-write monotonic state updates race under parallel webhooks; push the newer-than comparison into a single conditional upsert so stale events can never win.
- "One mapped device per vehicle" needs a partial unique index; app-level pre-checks alone let concurrent mapping requests both succeed.
- Telemetry side effects (mileage, timeline, alerts) must commit in the SAME transaction as the state/mapping decision, with ingestion and map/unmap serialized on a shared per-device advisory lock — otherwise a mapping change landing between phases writes to the former vehicle.
