---
name: GRA duty engine conventions
description: Non-obvious rules for the Guyana Revenue Authority vehicle import duty engine and its filing flow.
---

# GRA duty engine

- The rule: the duty engine never guesses. Incomplete drafts return empty tax lines + `missingInputs[]` (never throws); unresolvable cases (e.g. `diesel_cc_gap_1800_2000` — GRA publishes no under-4-year diesel band for 1800–2000cc) set `reviewFlags[]` that block filing at both UI and server.
- **Why:** duty totals are legally binding; inventing a rate or silently defaulting a band would produce wrong filings that pass review.
- **How to apply:** any new input to the engine must be added to `missingGraInputs`; any unpublished/ambiguous band must become a review flag, not a fallback rate. Server always recomputes at submission (422 on client/server total mismatch) and gate approval re-verifies from the immutable snapshot.
- Age category: "under 4 years" means yearOfManufacture >= yearOfImport − 3 (not a plain subtraction of 4).
- VAT exemptions (double-cab ≤2500cc, new <1500cc, hybrid <2000cc) apply only from 2026-02-16; EVs are fully zero-rated regardless.
- Regression suite: `pnpm --filter @workspace/scripts run verify-gra-duty` must pass after touching `lib/gra-duty/`.
