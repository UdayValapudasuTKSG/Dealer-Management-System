---
name: ERPNext integration foundation
description: Durable decisions the ERPNext entity-sync tasks must respect (queue-only I/O, SSRF policy, attempt semantics, webhook routing contract).
---

- All ERPNext I/O goes through the durable sync-job queue and per-DocType handler registries (outbound + inbound) — never a direct ERPNext call inside a request path. **Why:** ERPNext may be unconfigured/unreachable and must never block or break AURA.
- Jobs for a dealer without an enabled connection are parked and re-checked later WITHOUT consuming retry attempts; only real attempt failures count toward dead-letter. Non-retryable errors (auth, 404, non-JSON body) dead-letter immediately.
- SSRF policy: the GM-supplied site URL is fetched with the API token attached, so it must be HTTPS, public-host-only (DNS re-resolved and private/metadata/CGNAT/ULA ranges rejected before EVERY fetch, not just at save), with redirects disabled. Dev stub servers need `ERPNEXT_ALLOW_PRIVATE_URLS=1` (non-prod only).
- Inbound webhooks authenticate via a per-dealer shared secret header with timing-safe compare; the ERPNext webhook body template must include `doctype`/`name`/`event` — routing depends on it, unhandled DocTypes are recorded as "skipped".
- Secrets exposure: API secret never returned; API key masked; webhook shared secret readable by GM/super-admin only (they must paste it into ERPNext). Connection writes are GM-only.
- ERPNext doc names live in a generic external-refs mapping (dealer+entity+doctype unique); updates must resolve the mapped doc name, never guess.

## Entity sync durable invariants
- Every customer-write path must bump `updatedAt` and enqueue outbound sync, or inbound last-write-wins overwrites newer AURA data.
- ERPNext allocations/amounts are non-negative; direction lives in payment_type ("Pay" for refunds).
- Remote-create + local-ref is a crash window: persist the ref before submit and reconcile orphans by a deterministic remarks key before creating financial docs, or retries duplicate them.

## Environment/company mapping
- On 2026-10-10, the user explicitly confirmed ERPNext company `GT AUTOMOTIVE` on `https://erpnext-jcy-qlx.m.frappe.cloud` is test-only and authorized using it for AURA's CAM Motors Dummy dealership in production. Its screenshot showed GYD, Guyana and perpetual inventory enabled.
  **Why:** The AURA dealership and ERPNext company intentionally have different names; this particular mapping is approved for dummy testing.
  **How to apply:** Continue test setup for this pairing without repeatedly asking whether that company is live. This does not authorize connecting real GT/CAM dealerships, changing posting rules, or backfilling existing transactions.
- Treat ERPNext company selection as per-dealership configuration, not a universal production/UAT mapping. A dealership named “Dummy” inside AURA production does not establish that its ERPNext target is a test company. Use GYD for AURA accounting.
  **Why:** The earlier ksquare/ksquare UAT arrangement was not universal; a later production check found the dummy dealership targeting a differently named company. Sharing a live company can mix test activity into real books.
  **How to apply:** Read the selected dealership's current connection and confirm the target's test/live purpose before posting or backfilling. Preserve the explicitly selected company during connection tests and never silently default it to another company or currency.
