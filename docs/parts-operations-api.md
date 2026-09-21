# Parts operations API

All paths below are under `/api/parts/operations`. Every request requires authenticated dealer context (`x-dealer-id`) and **parts** permissions: GET=view; mutations=edit; adjustments, cycle approval, supplier sending, notification retry and variance resolution=approve. IDs are positive integers; quantities are non-negative integers. Errors use `{error:string}`. No endpoint implicitly sends supplier communications.

Implemented interface:

| Method/path | Request | Response |
|---|---|---|
| GET /locations | — | array of locations |
| POST /locations | `{name,type:"branch"\|"warehouse",address?}` | location |
| PATCH /locations/:id | `{name?,address?,active?}` | location; deactivation rejects stocked/reserved/counting locations |
| GET /bins | `locationId?` | array of bins |
| POST /bins | `{locationId,code,description?}` | bin |
| PATCH /bins/:id | `{code?,description?,active?}` | bin |
| GET /levels | `locationId?,binId?,partId?` | inventory rows including available quantity |
| GET /ledger | `locationId?,partId?,from?,to?,limit?` | newest transactions |
| GET /holds | `status?,locationId?,partId?` | holds |
| POST /holds | `{partId,locationId,binId?,quantity,referenceType:"job"\|"estimate"\|"quote",referenceId,expiresAt?}` | hold; risky holds explicitly flagged |
| POST /holds/:id/release | `{}` | released hold |
| POST /holds/:id/consume | `{}` | consumed hold (full quantity issue, idempotent) |
| POST /holds/expire | `{}` | `{released:number}` |
| GET /purchase-orders | `status?,source?` | PO review queue with lines and needsSupplier |
| POST /purchase-orders | `{supplierId?,locationId,expectedDate?,notes?,lines:[{partId,quantity,unitCost}]}` | manual draft PO with lines |
| POST /purchase-orders/generate | `{locationId?}` | `{orders:array}`; draft only, pending quantities deducted |
| POST /purchase-orders/special-order | `{partId,locationId,quantity,referenceType:"job"\|"estimate",referenceId,advisorId,idempotencyKey}` | draft PO |
| PATCH /purchase-orders/:id/supplier | `{supplierId}` | PO |
| POST /purchase-orders/:id/send | `{confirm:true,resend?:boolean}` | queued communication; explicit approval |
| GET /notifications | `status?` | delivery queue, errors visible |
| GET /notifications/sms-settings | — | `{ready,enabled,sender,setupLink,reason}`; no credentials exposed |
| POST /notifications/:id/retry | `{}` | pending notification |
| GET /cycle-counts | — | counts |
| GET /cycle-counts/:id | — | count with `lines` |
| POST /cycle-counts | `{locationId,binId?,category?}` | scoped count and lines |
| PUT /cycle-counts/:id/lines | `{lines:[{id,countedQuantity}]}` | count lines |
| POST /cycle-counts/:id/approve | `{}` | approved count; central stock ledger adjustment |
| POST /cycle-counts/:id/cancel | `{}` | cancelled count, locks released |
| GET /aging | `locationId?,category?,thresholds?:"30,60,90",format?:csv` | `{asOf,thresholds,rows,buckets,movementPolicy}` |
| GET /valuation | `asOf?,locationId?` | cost-supported valuation, missing history explicit |
| GET /replenishment | `locationId?` | seasonally weighted usage suggestions and explanations |
| GET /reconciliation | `status?` | comparison queue |
| POST /reconciliation | `{purchaseOrderId,invoiceNumber,tolerancePercent?,lines:[{purchaseOrderLineId,quantity,unitCost}]}` | matched/flagged lines |
| POST /reconciliation/:id/resolve | `{action:"accept"\|"dispute"\|"adjust",reason,quantity?,unitCost?}` | audited resolution |
| PATCH /parts/:id | `{description?,barcode?,costingMethod?:"average"\|"fifo"\|"landed",reorderLevel?,reorderMax?,active?}` | part; costing changes after ledger history rejected |
| PATCH /suppliers/:id | `{address?,leadTimeDays?}` | supplier |
| POST /issues | `{partId,locationId,binId?,quantity,referenceId,idempotencyKey,notes?}` | OTC issue ledger transaction |
| POST /adjustments | `{partId,locationId,binId?,quantityDelta,unitCost?,referenceId,idempotencyKey,reason,notes?}` | manager-approved ledger transaction |
| POST /transfers | `{partId,locationId,binId?,toLocationId,toBinId?,quantity,referenceId,idempotencyKey,notes?}` | `{outgoing,incoming}` ledger transactions |

### Exact response details

- Location: `{id,dealerId,name,type,address,active,isDefault,createdAt}`. Bin: `{id,dealerId,locationId,code,description,active}`. No hard delete: PATCH active=false protects stock, reservations, active counts and pending POs.
- Level: `{id,dealerId,partId,locationId,binId,quantityOnHand,quantityReserved,quantityNonSellable,quantityAvailable,averageUnitCost,updatedAt}`.
- Ledger: `{id,dealerId,partId,locationId,binId,type,quantityDelta,nonSellableDelta,referenceType,referenceId,unitCostAtTransaction,valueDelta,createdBy,createdAt,idempotencyKey,notes}`.
- Hold: `{id,dealerId,partId,locationId,binId,quantity,referenceType,referenceId,status,backorderRisk,expiresAt,releasedAt,createdAt,createdBy}`.
- PO: existing PO fields plus `{source,locationId,jobCardId,estimateId,advisorId,createdBy,sentAt,sendCount,needsSupplier,lines}`. Line quantity fields are **quantity** and **qtyReceived**, not quantityOrdered/quantityReceived. Existing `ordered` status means sent. Send endpoint returns a delivery row, not a PO; status advances only after transport succeeds.
- Cycle: `{id,dealerId,locationId,binId,category,status,startedBy,startedAt,completedAt,approvedBy}`. Detail adds `lines:[{id,cycleCountId,partId,binId,expectedQty,countedQty,variance,approvedBy,transactionId}]`. Enter request uses **countedQuantity**, response uses **countedQty**. Pending-approval lines can still be edited; approval locks and posts all variances atomically.
- Aging row: `{partId,sku,name,category,status,locationId,quantity,currentValue,lastMovementAt,historyStartAt,ageDays,ageBasis,bucket,historicalAgeUnknown}`. Buckets: `{bucket,quantity,value}`. No outbound movement falls back to first observed ledger date, explicitly labelled; receipts do not reset movement. Default thresholds 30/60/90, configurable ascending comma-separated days. CSV has the row fields.
- Valuation: `{asOf,rows:[{partId,sku,name,locationId,method,quantity,value,legacyOpening,costBasis}],byLocation:[{locationId,value}],totalValue,incomplete,unavailable:[{partId,sku,reason}]}`. `asOf` accepts ISO timestamp, or date-only interpreted as end of UTC calendar day (today means now); future dates rejected. Historical pre-adoption cost unavailable rather than inferred.
- Replenishment is an array: `{partId,sku,name,min,max,leadTimeDays,locationId,available,pending,historyStart,suggestedQuantity,dailyVelocity?,leadTimeDemand?,target?,daysUntilReorder?,historyDays?,explanation?,dataMaturity?,reason?}`. No actual outbound history or missing lead time yields null suggestion with reason.
- Reconciliation rows include persisted invoice fields and `orderedQuantity,orderedUnitCost,currentReceivedQuantity,flags:{quantityMismatch,priceMismatch,priceVariancePercent,partiallyReceived}`. Split vendor invoices count earlier non-disputed invoiced quantities. Partial receipts alone do not force a discrepancy when the invoice only bills the received portion. Adjust corrects recorded invoice data, not physical stock.
- Delivery: `{id,dealerId,recipientId,channel,type,referenceType,referenceId,status,attempts,payload,errorMessage,sentAt,createdAt}`. Status pending/sending/sent/failed; payload contains PO link. Retry only failed deliveries. A crash after provider acceptance remains sending and needs investigation, not an automatic resend.

### Integration and operational caveats

Mount default router from `routes/parts-operations.ts` at `/parts/operations` inside existing authenticated router. **Do not mount it outside requireAuth/authorize/auditTrail.**

Receipt integration must call `postPartsReceipt(tx,{dealerId,purchaseOrderId,actorId?})` from `lib/parts-operations.ts` after updating cumulative receipt quantities, in the SAME transaction. Receipt quantities form the dedupe key, allowing partial-receipt updates without retry spam.

Wire `startPartsOperationsWorker()` / `stopPartsOperationsWorker()` from `lib/parts-operations-worker.ts`. The worker runs hold expiry, low-stock drafts, and notification delivery every minute for active entitled dealers. `generateLowStockOrders(dealerId,null)` records system-created drafts with no fabricated user ID. Generation is dealer serialized. SMTP reuses `resolveDealerSmtp`. `OUTBOX_WORKER_DISABLED=1` disables both the worker and explicit delivery sweeps.

SMS reuses the installed Twilio SDK and existing `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN`. Administrator-managed `PARTS_SMS_DEALER_SENDERS` is a JSON object keyed by dealer ID; each allowed dealer must explicitly set `enabled: true` and `from` to its SMS-capable E.164 sender. No global voice/WhatsApp sender fallback exists. Missing opt-in/configuration or missing/non-E.164 advisor phone produces a durable failed notification with setup guidance; an administrator can configure deployment settings, then approve retry. The adapter checks active dealer membership before sending to the advisor's staff phone. The readiness endpoint exposes no credentials. Tests can alternatively inject `transport.sms(dealerId,recipientId,body)`.

Tests must inject transport callbacks and never invoke default live email transport. No worker starts on import. Estimate reference IDs refer to the existing job-card estimate, not sales quotation IDs (quotes are supported separately for holds).

Integration ownership: foundation agent owns all schema, stock/cost/hold primitives. Receipt integration should invoke exported `postPartsReceipt` transactionally; the exported delivery sweep is never started by importing a module. Provider tests must inject a transport and must not send real messages.