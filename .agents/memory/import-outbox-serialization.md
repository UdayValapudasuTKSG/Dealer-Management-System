---
name: Import communication suppression
description: Why reviewed historical imports must coordinate with customer-message transport
---

Reviewed-import suppression must serialize with the final provenance check and provider hand-off, not just cancel pending outbox rows.

**Why:** A claimed sender can read pre-import metadata, then send after the import commits suppression. Queue-state filtering alone cannot close that window. Legacy rows without lead IDs also need matching coordination identities, while new explicit lead IDs must not inherit another lead's suppression through a shared address.

**How to apply:** Preserve the shared deterministic lock identities on conversion and sender paths. Keep post-claim policy failures inside per-item retry handling. Verify races with real database connections and fake transport, with guarded fixtures that the running development worker cannot consume.

Legacy customer/address inference is only for pre-import sales/delivery messages, never a permanent customer-wide ban.

**Why:** Future unrelated service appointments and collision claims can legitimately lack a sales lead ID. Treating all leadless messages for an imported customer's address as suppressed blocks their after-sales service.

**How to apply:** Keep legacy template/context and import-time boundaries aligned between conversion cancellation and send-time policy. Explicit lead provenance remains scoped to that lead.