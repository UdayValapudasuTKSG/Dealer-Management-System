---
name: GRA duty engine conventions
description: Server-authoritative Guyana import duty flow — dealer_taxes-driven engine, gate-then-file state machine, drift checks.
---

# GRA duty engine conventions

- Duty is computed ONLY server-side from the dealer's `dealer_taxes` rules via `computeDraftDuty(dealerId, draft)` (api-server/src/lib/gra-duty.ts): duty %CIF (threshold-aware) → excise %(CIF+duty) → VAT %(CIF+duty+excise) → levies/fixed. Rules flagged `excludeEv` are skipped for electric vehicles (`evSkipped[]`). The client never computes duty.
- The engine never guesses: missing inputs (cifValue, engineCc for non-EV, fuelType, year) come back as `missingInputs[]` with empty tax lines — never a thrown error or fallback rate. **Why:** duty totals are legally binding; a silent default would produce wrong filings that pass review.
- The legacy hardcoded-band engine (`lib/gra-duty` package, importerType/bodyType/retailPrice branching, diesel-gap review flags) is no longer used by the server; everything is dealer_taxes-driven.
- AI extraction is allowlisted to make/model/year/cifPrinted/engineCc/fuelType with per-field confidence; fields below MIN_AGENT_CONFIDENCE are dropped (`dropped[]`); an all-illegible doc 422s. TIN/VIN/owner/HS code are ALWAYS human-keyed, never auto-filled.
- State machine: `POST /gra/review` creates a gate + `pending_gate` filing snapshot → officer approves the gate (approve only AUTHORISES, never files) → `POST /gra/filings` (idempotency header required) recomputes and flips to filed. 404 foreign gate/vehicle, 409 unresolved/rejected/already-filed, 422 on drift or client mismatch. CIF components (FOB+freight+insurance) must sum to CIF.
- Drift checks must be LINE-LEVEL, not total-only — a tax-rule change can alter composition while preserving the total. Use `taxLinesMatch()` (code/kind/rate/basis/baseAmount/amount) at BOTH the gate-approval precheck and the filing route.
- **How to apply:** any change to dealer_taxes semantics or the filing snapshot shape must keep recompute-equality enforced at approval AND filing; new engine inputs must be added to `missingInputs` handling.
