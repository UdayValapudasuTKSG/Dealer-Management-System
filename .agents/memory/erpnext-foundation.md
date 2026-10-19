---
name: ERPNext integration foundation
description: Durable decisions the ERPNext entity-sync tasks must respect (queue-only I/O, SSRF policy, attempt semantics, webhook routing contract).
---

- All ERPNext I/O goes through the durable sync-job queue and per-DocType handler registries (outbound + inbound) — never a direct ERPNext call inside a request path. **Why:** ERPNext may be unconfigured/unreachable and must never block or break AURA.
- Jobs for a dealer without an enabled connection are parked and re-checked later WITHOUT consuming retry attempts; only real attempt failures count toward dead-letter. Non-retryable errors (auth, 404, non-JSON body) dead-letter immediately.
- Exclude disconnected dealers before applying the queue batch limit; read-only GL validation must not wait behind the normal sync backlog.
  **Why:** Thousands of unconnectable old jobs repeatedly filled batches, leaving connected-dealer validation unattempted for over a day. Per-job parking after selection does not prevent starvation.
  **How to apply:** Preserve parked jobs for reconnection, gate candidates in SQL, and verify priority with a backlog containing multiple dealerships.
- SSRF policy: the GM-supplied site URL is fetched with the API token attached, so it must be HTTPS, public-host-only (DNS re-resolved and private/metadata/CGNAT/ULA ranges rejected before EVERY fetch, not just at save), with redirects disabled. Dev stub servers need `ERPNEXT_ALLOW_PRIVATE_URLS=1` (non-prod only).
- Inbound webhooks authenticate via a per-dealer shared secret header with timing-safe compare; the ERPNext webhook body template must include `doctype`/`name`/`event` — routing depends on it, unhandled DocTypes are recorded as "skipped".
- Secrets exposure: API secret never returned; API key masked; webhook shared secret readable by GM/super-admin only (they must paste it into ERPNext). Connection writes are GM-only.
- ERPNext doc names live in a generic external-refs mapping (dealer+entity+doctype unique); updates must resolve the mapped doc name, never guess.

## Entity sync durable invariants
- Final-invoice posting may precede deal commitment only for a desking deal with its own active, unexpired reservation of the exact VIN. Payment still follows invoice posting; commitment and handover retain settlement checks.
  **Why:** Requiring commitment before the invoice, while commitment requires full payment and payment requires a posted invoice, makes a new sale impossible. The user authorized repairing this ordering after the end-to-end test exposed it.
  **How to apply:** Never remove reservation ownership, VIN, independent Finance approval or delivery settlement checks to resolve this cycle. Recheck reservation eligibility at posting, not only submission. Advance-VAT policy remains a separate blocked path.
- Every customer-write path must bump `updatedAt` and enqueue outbound sync, or inbound last-write-wins overwrites newer AURA data.
- ERPNext allocations/amounts are non-negative; direction lives in payment_type ("Pay" for refunds).
- Remote-create + local-ref is a crash window: persist the ref before submit and reconcile orphans by a deterministic remarks key before creating financial docs, or retries duplicate them.
- Serialize the whole remote create/reference/submit operation, including expense journals, not only local receipt creation.
  **Why:** Local payment deduplication can pass while concurrent workers still create duplicate ERP documents before either saves the remote reference.
  **How to apply:** Keep posting serialization compatible with the dealer hold/enrolment lock; verify concurrent runs invoke the remote creation path only once.

## Environment/company mapping
## Workflow document versus master accounts
- The user wants finance inputs and manager approvals inside sales lead details: payment type, source, amount, registration/fuel/PDI costs, and customer-versus-financier balances.
  **Why:** Finance should control the sale from its pipeline record rather than maintaining disconnected workpapers.
  **How to apply:** Separate receipts from expenses, keep transaction-level approval and ERP posting status distinct, and retain the pending advance-VAT restriction until explicitly changed.
- On 2026-10-15 the user reiterated that the pipeline must execute the approved financial flow, not just prepare workpapers: request source and amount, show Finance-only approve/reject, and post approved transactions to ERPNext.
  **Why:** Workpaper-only delivery did not satisfy the requested sales workflow.
  **How to apply:** Treat operational approval-to-posting as required scope, with independent expense/receipt records, rejected requests leaving books unchanged, and posted status only after confirmed ERP success. Do not call review-only scaffolding complete. Covered sales must not bypass approval through legacy payment or sync paths. Keep advance-VAT restrictions separate from authorization to build the execution engine.
- On 2026-10-15 the user authorised all-dealer availability for NEW sales only, preserving existing sales on their existing process.
  **Why:** A blanket dealer-wide switch would block historical payments and postings on deals that cannot safely be enrolled.
  **How to apply:** Persist the activation boundary across publishes/restarts. Classify by sale origin, not invoice date; an old booking converted later remains existing business. Preserve prior dummy/enrolled-deal protections and held transactions. Do not copy account mappings, unpause connections or change tax policy as part of rollout.
- The user chose to hold existing unsent CAM Motors Dummy financial jobs for Finance review before reconnecting ERPNext; this is not permission to replay the backlog.
  **Why:** Replacing the connection credentials would otherwise let older invoices and payments bypass the requested new approval flow.
  **How to apply:** Preserve posted documents and existing receipts. Keep legacy financial holds effective across retries and new jobs for the same entity. Do not retry failed jobs or turn a legacy receipt into a second receipt. Reconnection must not release holds; explicit Finance review and posting reconciliation are required.
- Registration, fuel and PDI billing is chosen per expense, defaulting to dealer-paid; a separate customer charge requires Finance approval.
  **Why:** The user explicitly selected per-expense billing rather than treating all costs as dealer expenses or automatically included in the vehicle price.
  **How to apply:** Preserve the dealer expense and any customer charge as separate linked transactions. Do not increase the customer balance merely because an expense was submitted.
- Finance will configure and approve customer-charge GL accounts and VAT treatment per expense category before posting; no default tax exemption or vehicle-tax inheritance is authorized.
  **Why:** The user selected configuration-before-posting because the workflow document defines dealer costs but not the tax treatment of customer recharges.
  **How to apply:** Keep unconfigured categories blocked; explicitly distinguish pending, taxable, exempt and zero-rated, including inclusive/exclusive amounts. Configuration approval alone does not authorize advance VAT or replace transaction-level Finance approval.
- The user supplied the expanded master account definitions directly in the connected ERPNext test company. Use the live account list to resolve model/brand accounts rather than requiring the missing standalone master PDF again.
  **Why:** The workflow PDF had only ranges, but the user subsequently populated the actual ledgers. Corresponding sales, stock and COGS accounts do not universally share matching numeric suffixes.
  **How to apply:** Validate explicit model/variant-to-account mappings against the live chart, including duty-free variants; never derive a stock or COGS account by replacing an income-account prefix. Revalidate saved AURA account names after chart changes.
- Reuse compatible existing test-company accounts without renumbering them to the workflow's seven-digit codes; retain an explicit source-code-to-ERPNext-account cross-reference.
  **Why:** The initial ERPNext company used a four-digit chart with configured defaults. The user subsequently populated a seven-digit chart; the live chart, not either historical numbering convention, is authoritative. Replacing or renumbering accounts risks breaking references.
  **How to apply:** Resolve by exact ERPNext account document name for AURA settings. Do not assume a workflow code is itself an ERPNext account identifier, or that created accounts implement the related posting flow.
- Do not invent a duty-free income mapping merely to validate a normal-sale model.
  **Why:** The connected chart has ordinary model ledgers without a corresponding duty-free income leaf for every model.
  **How to apply:** Permit the unused duty-free mapping to remain blank, but block actual duty-free sales until Finance supplies an explicit applicable account. Never silently reuse normal income or another model's duty-free ledger.
- The supplied GT Transaction Workflows v1.0 references a separate ERP Master Chart of Accounts v1.0; it does not define every model/brand ledger. Treat code ranges and `xx` placeholders as unresolved, not permission to invent accounts.
  **Why:** A workflow posting guide supplies account purposes and control accounts but lacks the leaf mappings needed for a complete ERPNext chart.
  **How to apply:** Keep prepared charts explicitly draft until the master list and existing ERPNext account export/template are reconciled. Never replace an existing company chart or load historical balances from narrative examples.

## Confirmed test environment
- The user authorised isolated, clearly labelled sample vehicles and artificial costs for the dummy sales-flow test, separate from existing inventory and transactions.
  **Why:** No authoritative VIN stock/cost records were initially present in ERPNext; selling prices must never be substituted for landed costs.
  **How to apply:** Keep test fixtures identifiable and excluded from historical backfills. Direct fixture-script success is not proof that AURA's production handlers implement that flow.
- The test site's stock and compliance features affect API payloads: serial support must be enabled before serialised Item creation, and its installed HSN validator requires an existing six/eight-digit code even for dummy items.
  **Why:** Company country/currency alone does not control installed compliance extensions. The site rejected otherwise-valid test Items.
  **How to apply:** Inspect actual enabled features and metadata; do not disable compliance validation or copy dummy classifications into live items. Customer names must also differ from Customer Group names.
- Do not apply the dummy EV classification to the shared generic AURA sales item to make an end-to-end run pass.
  **Why:** The real application posting path uses a shared non-stock sales item for vehicles and other invoices, unlike the old standalone serialised EV fixture. A classification appropriate for one EV does not establish the classification for every invoice.
  **How to apply:** Resolve validated dealer/model-specific ERP item and classification mappings before claiming live ERP posting works. Keep stock/COGS verification separate: a non-stock invoice is not evidence of a VIN stock-out.
- On 2026-10-19 the user approved CAM Motors Dummy advances as liabilities, with 14% VAT at final invoicing. This supersedes the earlier pending-policy decision ONLY for that dummy dealership; other dealers remain pending.
  **Why:** The user explicitly chose "VAT at final invoicing; deposit held as a liability" and supplied "14% vat".
  **How to apply:** Keep the exception scoped to the confirmed dummy dealership, retain independent transaction approval, and never replay blocked/held requests automatically. Final invoices must show full taxable value and deposits must clear separately, not reduce revenue or the VAT base.
- On 2026-10-14 the user initially restricted the Sales & F&I rollout to CAM Motors Dummy and kept advance-VAT posting blocked pending finance approval.
  **Why:** The new workflow's tax policy is awaiting approval; the presence of a deposit or VAT account does not authorize posting.
  **How to apply:** Do not activate advance posting or broaden rollout to live dealerships without approval. Production's approved dummy dealership is ID 2. Never retroactively enrol transactions with existing receipts or attempted ERP postings. Current workpapers are preparation/review, not financial execution.
- On 2026-10-10, the user explicitly confirmed ERPNext company `GT AUTOMOTIVE` on `https://erpnext-jcy-qlx.m.frappe.cloud` is test-only and authorized using it for AURA's CAM Motors Dummy dealership in production. Its screenshot showed GYD, Guyana and perpetual inventory enabled.
  **Why:** The AURA dealership and ERPNext company intentionally have different names; this particular mapping is approved for dummy testing.
  **How to apply:** Continue test setup for this pairing without repeatedly asking whether that company is live. This does not authorize connecting real GT/CAM dealerships, changing posting rules, or backfilling existing transactions.
- Treat ERPNext company selection as per-dealership configuration, not a universal production/UAT mapping. A dealership named “Dummy” inside AURA production does not establish that its ERPNext target is a test company. Use GYD for AURA accounting.
  **Why:** The earlier ksquare/ksquare UAT arrangement was not universal; a later production check found the dummy dealership targeting a differently named company. Sharing a live company can mix test activity into real books.
  **How to apply:** Read the selected dealership's current connection and confirm the target's test/live purpose before posting or backfilling. Preserve the explicitly selected company during connection tests and never silently default it to another company or currency.
