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
- **AURA models exactly ONE warehouse per dealer.** Inbound movements/reconciliations only count rows touching the configured default warehouse (all rows only when none is configured); transfers between foreign warehouses must not move AURA stock.
- **Backordered issues move no stock at issue time** — the Material Issue posts only when the backorder fills, keyed by the job-card line id (fills exactly once), enqueued after the transaction commits.
- **Movement handlers self-heal ordering:** they resolve-or-create the Item/Supplier (ref → SKU/name match → create) so movement jobs never dead-letter on missing masters, and backfills stay duplicate-free.
