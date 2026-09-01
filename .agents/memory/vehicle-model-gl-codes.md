---
name: Vehicle model GL codes
description: Conventions for the Finance vehicle-model GL code mapping and how ERPNext invoice posting resolves/snapshots income accounts.
---

- Make/model identity always goes through the single shared `normalizeModelKey()` exported from `@workspace/db` (trim, collapse whitespace, lowercase). Grouping is done in JS after fetching raw make/model — never a SQL-side normalizer, or the two drift.
- Mapping rows are dealer-scoped with TWO partial-free unique indexes: `(dealer_id, make_key, model_key)` and `(dealer_id, gl_code)`. Duplicate code → 23505 (in `err.cause` under drizzle) → 409.
- ERPNext invoice posting (`handleSalesInvoiceJob`) resolves income account: deal → vehicle → normalized keys → mapping; falls back ONLY to the dealer-wide `conn.incomeAccount`, never another model's code. The resolved account/source is snapshotted into the sync job's payload after ref save; the existing-ref short-circuit guarantees later mapping edits never rewrite historical postings.
- ERPNext validation matches Account by doc name first, then `account_number` filter; connector failure = 502 and NO status changes (statuses keep last-known values). Changing a glCode resets erpnextStatus/checkedAt to null.
- Orphan mappings (model left inventory) stay in the list with `vehicleCount: 0`.

**Why:** Finance tracks model-level accounting; silent fallback to a wrong code or rewritten history would corrupt postings.
**How to apply:** any new consumer of model-level GL codes must reuse `normalizeModelKey` and read the job-payload snapshot for historical values.
