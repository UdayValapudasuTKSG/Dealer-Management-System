---
name: GYD-only currency
description: GYD-only storage with an explicitly authorized labour-pricing USD conversion exception.
---

The entire system stores and displays money in GYD only. **Why:** user chose full re-denomination — historical USD-scale amounts were migrated (multiplied by each dealer's/document's snapshotted `usd_exchange_rate`, rounded to whole GYD; GYD has no cents).

**How to apply:**
- The legacy general `dealers.usdExchangeRate` remains compatibility metadata pinned to 1. Do not revive general document conversion or multiply existing GYD amounts.
- `invoices/receipts.currency` = "GYD", `exchange_rate` = 1. `useMoney()` in aura formats GYD directly; `usd`/`dual` are deprecated aliases of `gyd`.
- GRA filings' CIF/FOB etc. are stored in GYD; `gra_filings.exchange_rate` = 1 for migrated rows.
- Migration guard was `usd_exchange_rate > 1.5`, so re-running conversions is safe only while rates stay 1.
- `scripts/src/verify-gra-duty.ts` still exercises rate plumbing with its own dealer (self-consistent); engine rate logic intact but a no-op at rate 1.
- USD-scale labels outside the explicitly authorized labour-pricing input are stale.

## Labour-pricing exception

The user explicitly clarified that default labour is **US$120/hour**, not GYD 120, and selected **209 GYD per US$1** as the initial editable dealership labour exchange rate. They subsequently requested configurable hourly rates by vehicle brand; 209 remains the exchange rate, not a USD hourly price.

**Why:** GYD-only storage must not change the economic meaning of a USD-denominated base price; GYD 120/hour substantially understates the requested charge.

**How to apply:** Convert the USD base once when establishing a labour quote rate, snapshot the resulting GYD hourly amount, and keep all downstream quote/invoice amounts in GYD. Use a separate labour-specific setting, not the legacy document exchange rate. Setting changes must not silently reprice existing approved quotes or invoices; an explicit draft revision must follow normal approval supersession.

Brand overrides are dealer-specific USD/hour inputs. Do not invent premium-brand tiers or change existing rates merely because a brand is selected; unconfigured brands retain the USD120 default.

**Why:** The user requested customization, not an automatic change to the dealership's price schedule.

**How to apply:** Track the selected booking brand, use authoritative linked-vehicle make when present, and snapshot its effective rate on new cards. Changing brand metadata or rate settings must leave existing cards unchanged until the explicit apply-current-rate action.
