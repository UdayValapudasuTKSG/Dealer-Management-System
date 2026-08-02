---
name: GYD-only currency
description: The system was re-denominated from USD storage to GYD-only (Aug 2026); exchange-rate concept removed.
---

The entire system stores and displays money in GYD only. **Why:** user chose full re-denomination — historical USD-scale amounts were migrated (multiplied by each dealer's/document's snapshotted `usd_exchange_rate`, rounded to whole GYD; GYD has no cents).

**How to apply:**
- `dealers.usdExchangeRate` still exists but is pinned to 1 (default 1); platform routes ignore client attempts to change it. Never reintroduce `?? 209` style fallbacks — any rate fallback must be 1, and new money paths must not multiply by a rate.
- `invoices/receipts.currency` = "GYD", `exchange_rate` = 1. `useMoney()` in aura formats GYD directly; `usd`/`dual` are deprecated aliases of `gyd`.
- GRA filings' CIF/FOB etc. are stored in GYD; `gra_filings.exchange_rate` = 1 for migrated rows.
- Migration guard was `usd_exchange_rate > 1.5`, so re-running conversions is safe only while rates stay 1.
- `scripts/src/verify-gra-duty.ts` still exercises rate plumbing with its own dealer (self-consistent); engine rate logic intact but a no-op at rate 1.
- Any surviving "USD-scale" comments/labels are stale — fix on sight.
