---
name: ERPNext parts & purchasing sync
description: Durable invariants of the parts/stock/PO sync — double-count traps, echo suppression, inbound idempotency, warehouse scoping.
---

# ERPNext parts & purchasing sync — invariants

- **PO receipts post a Purchase Receipt ONLY — never also a Stock Entry.**
  **Why:** an ERPNext Purchase Receipt moves warehouse stock itself; adding a Stock Entry for the same receipt double-counts on-hand qty.
  **How to apply:** any new receive path picks exactly one of the two document forms.
- **Inbound stock docs are claimed once per (dealer, doctype, docName)** via a unique dedupe key before any stock is touched.
  **Why:** ERPNext redelivers webhooks and fires multiple lifecycle events for one submitted (immutable) document; applying deltas twice corrupts stock.
- **Outbound Stock Entries carry an "AURA" remark prefix as an in-document echo marker.**
  **Why:** the saved doc ref alone is racy — ERPNext's webhook can arrive before the sync worker persists the ref, so the inbound handler must recognise AURA-originated docs from the payload itself.
- **ERPNext mapping remains ONE configured warehouse per dealer even though AURA supports multiple inventory locations/bins.** Inbound movements/reconciliations map to the AURA default location and only count rows touching the configured ERP warehouse (all rows only when none is configured); do not invent location-to-ERP mappings.
  **Why:** The Parts expansion adds operational locations without authorizing a new ERP warehouse mapping.
  **How to apply:** Keep outbound and inbound warehouse scope explicit; foreign ERP warehouse transfers must not change AURA stock.
- **Backorders reserve stock when filled; they do not issue it.** Material Issue posts on physical issue or billing of still-unissued parts, after the transaction commits.
  **Why:** The user selected physical-issue timing; receipt-driven issue would now deduct before staff picks the part.
  **How to apply:** Do not restore receipt-triggered issue enqueues; retain per-line movement dedupe and stock-neutral financial credits.
- **Movement handlers self-heal ordering:** they resolve-or-create the Item/Supplier (ref → SKU/name match → create) so movement jobs never dead-letter on missing masters, and backfills stay duplicate-free.

## Fire-and-forget enqueue race
Parts import responds before its ERPNext part/supplier sync jobs are (re)enqueued — a job can flip back to queued moments after the HTTP response. Any cleanup/suppression sweep must loop until a full pass finds nothing (see scripts/src/expand-atl-uat.ts suppressUatErpJobs). Re-enqueue with the same dedupe key also resurrects dead jobs back to queued.
