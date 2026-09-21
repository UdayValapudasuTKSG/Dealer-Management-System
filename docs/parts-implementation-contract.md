# Parts implementation contract

Foundation owner: schema and central stock mutations. Existing parts/suppliers/PO/job/credit tables remain authoritative. `parts.supplierId` is preferred supplier; `reorderLevel` is reorder minimum. Existing PO `ordered` means sent. No startup DDL.

## New exports (@workspace/db)

- `inventoryLocationsTable`: id, dealerId, name, type (branch/warehouse), address, active, isDefault, createdAt.
- `inventoryBinsTable`: id, dealerId, locationId, code, description, active.
- `inventoryLevelsTable`: id, dealerId, partId, locationId, binId nullable, quantityOnHand, quantityReserved, quantityNonSellable, averageUnitCost, updatedAt. Available = onHand - reserved - nonSellable; may be negative for risky holds, never negative physical stock.
- `inventoryTransactionsTable`: id, dealerId, partId, locationId, binId, type, quantityDelta, nonSellableDelta, referenceType, referenceId (text), unitCostAtTransaction, valueDelta, createdBy, createdAt, idempotencyKey, notes. Immutable application ledger; corrections append reversals.
- `inventoryCostLayersTable`: id, dealerId, partId, locationId, binId, receiptTransactionId, quantityReceived, quantityRemaining, unitCost, nonSellable, createdAt. Opening balances are dated now and marked legacy_opening, never invented receipt history.
- `inventoryCostConsumptionsTable`: id, dealerId, layerId, transactionId, quantity, unitCost, createdAt. Persistent FIFO consumption; as-of reconstruct layers using dated consumptions (not current remaining only).
- `inventoryHoldsTable`: id, dealerId, partId, locationId, binId, quantity, referenceType, referenceId (text), status, backorderRisk, expiresAt, releasedAt, createdAt, createdBy.
- `inventoryCycleCountsTable`: id, dealerId, locationId, binId, category, status, startedBy, startedAt, completedAt, approvedBy.
- `inventoryCycleCountLinesTable`: id, dealerId, cycleCountId, partId, binId, expectedQty, countedQty, variance, approvedBy, transactionId.
- `partPricingPoliciesTable`: id, dealerId, category nullable (global), markupFactor, reconciliationTolerancePercent, holdExpiryDays, updatedAt.
- `partImportJobsTable`: id, dealerId, status, mode, fileName, columnMapping, rows, errors, processedRows, totalRows, createdBy, createdAt, startedAt, completedAt, errorMessage. Persist validated rows and errors; durable claiming via status/startedAt.
- `partReconciliationsTable`: id, dealerId, purchaseOrderId, purchaseOrderLineId, receiptId, invoiceNumber, invoiceQuantity, invoiceUnitCost, receivedQuantity, tolerancePercent, status, resolution, notes, resolvedBy, resolvedAt, createdAt.
- `partNotificationDeliveriesTable`: id, dealerId, recipientId, channel, type, referenceType, referenceId (text), status, attempts, payload, errorMessage, sentAt, createdAt. Delivery audit/outbox supplements existing in-app notifications.

## Existing extensions

Part: description, barcode, costingMethod (average/fifo/landed), reorderMax, active, updatedAt, inventoryInitializedAt.
SKU uniqueness is tenant-scoped `(dealerId, sku)`, not global. Tracked development migration `2026-09-18-parts-tenant-sku.sql` creates composite uniqueness before removing the obsolete global constraint.
Supplier: address, leadTimeDays (status remains authoritative).
PO: source (manual/low_stock_alert/special_order), locationId, jobCardId, estimateId, advisorId, createdBy, sentAt, sendCount, needsSupplier.
PO line: landedCostComponents `{freight?,duty?,handling?,other?}` (total allocated line amounts), landedUnitCost nullable.
Job part: inventoryHoldId, inventoryLocationId, inventoryBinId, issuedQuantity nullable/default NULL, issuedAt. NULL distinguishes legacy; new attached lines must explicitly set 0. Legacy lines require conservative adoption by workflow (old non-backordered issue lines already reduced legacy stock).
Credit note: condition (resalable/damaged/scrap), inventoryTransactionId.

## Stock module interface

Implemented file `artifacts/api-server/src/lib/parts-inventory.ts`:
`ensureInventory(tx, dealerId, partId)` locks tenant-scoped part, ensures default location, lazily adopts aggregate legacy stock once; returns `{part, location}` (part is the pre-adoption locked row).
`moveStock(tx, input)` with dealerId, partId, locationId?, binId?, type, quantityDelta, referenceType, referenceId string, unitCost?, nonSellableDelta?, createdBy?, idempotencyKey?, notes?, allowDuringCount?; returns ledger row. All operations require enclosing db.transaction. Locks serialize on part before level/hold/layers.
`createHold(tx, input)` dealerId, partId, locationId?, binId?, quantity, referenceType, referenceId string, createdBy?, expiresAt?; returns hold.
`releaseHold(tx, dealerId, holdId)` and `consumeHold(tx, dealerId, holdId, issue?)` (consume entire active hold and issue in same tx).

`consumeHold` issue options: referenceType?, referenceId?, createdBy?; returns issue ledger row and uses stable internal key `hold-consume:<holdId>`. Repeated consumption returns original ledger; released hold consumption errors. `releaseHold` returns hold and is idempotent. Partial issue: release original hold, create/consume the issued-quantity hold and create a remaining hold in ONE transaction. Deterministic reference IDs are strings. `moveStock` enforces cycle-count line locks unless allowDuringCount=true (manager-approved count posting only). FIFO consumption persists exact receipt costs; average/landed issue uses current level weighted cost. Inbound landed costs must be calculated by receiving caller and supplied as unitCost.
Explicit createHold expiresAt must be valid and strictly in the future. Oversubscribed holds remain allowed and flagged as backorderRisk; available can be negative. Master unitCost is used only for the explicit legacy opening snapshot or initial empty-level default; historical valuation reads persisted ledger/layer/consumption values and must never reprice history from current part master cost.

Development migration `lib/db/migrations/2026-09-18-parts-inventory.sql` applied successfully through database skill, development only. No production changes; no startup DDL. Opening stock lazy adoption is strict: existing levels without a marker fail visibly rather than silently invent a reconciliation. Opening FIFO is current-cost-at-adoption, with explicit legacy provenance and no claimed historical accuracy.

Attach reserves; explicit issue deducts; billing only issues previously unissued quantities. Returns and financial credit are distinct; ERPNext financial returns stay stock-neutral. Per-location PO defaults, seven-day holds, issue/transfer aging only, browser-camera scanning.

All API lookups must constrain dealerId and validate referenced ownership. Do not trust global FK existence as tenant authorization. Transfers call two moves in one transaction, using outgoing ledger cost for incoming stock. For multi-part operations lock parts in ascending ID order.

ERPNext existing integration models one configured warehouse per dealer. New inventory locations must not automatically be treated as ERP warehouses: inbound default-warehouse movements map to the AURA default location until an explicit location mapping is built. Preserve receipt-only outbound PO sync, inbound document dedupe, AURA echo suppression, and stock-neutral financial credit.