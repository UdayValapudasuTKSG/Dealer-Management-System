import { sql } from "drizzle-orm";
import { pgTable, serial, integer, text, boolean, timestamp, doublePrecision, jsonb, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { partsTable, purchaseOrdersTable, purchaseOrderLinesTable, purchaseOrderReceiptsTable } from "./workshop";

const identity = () => ({ id: serial("id").primaryKey(), dealerId: integer("dealer_id").notNull() });
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const inventoryLocationsTable = pgTable("inventory_locations", {
  ...identity(), name: text("name").notNull(), type: text("type").notNull().default("warehouse"),
  address: text("address"), active: boolean("active").notNull().default(true),
  isDefault: boolean("is_default").notNull().default(false), createdAt: createdAt(),
}, t => [
  uniqueIndex("inventory_locations_dealer_name_uq").on(t.dealerId, t.name),
  uniqueIndex("inventory_locations_default_uq").on(t.dealerId).where(sql`${t.isDefault}`),
  check("inventory_locations_type_ck", sql`${t.type} in ('branch','warehouse')`),
]);
export const inventoryBinsTable = pgTable("inventory_bins", {
  ...identity(), locationId: integer("location_id").notNull().references(() => inventoryLocationsTable.id),
  code: text("code").notNull(), description: text("description"), active: boolean("active").notNull().default(true),
}, t => [
  uniqueIndex("inventory_bins_scope_uq").on(t.dealerId, t.locationId, t.code),
  check("inventory_bins_code_ck", sql`length(trim(${t.code})) > 0`),
]);

const stockScope = () => ({
  ...identity(), partId: integer("part_id").notNull().references(() => partsTable.id),
  locationId: integer("location_id").notNull().references(() => inventoryLocationsTable.id),
  binId: integer("bin_id").references(() => inventoryBinsTable.id),
});
export const inventoryLevelsTable = pgTable("inventory_levels", {
  ...stockScope(), quantityOnHand: integer("quantity_on_hand").notNull().default(0),
  quantityReserved: integer("quantity_reserved").notNull().default(0),
  quantityNonSellable: integer("quantity_non_sellable").notNull().default(0),
  averageUnitCost: doublePrecision("average_unit_cost").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("inventory_levels_scope_uq").on(t.dealerId, t.partId, t.locationId, sql`coalesce(${t.binId}, 0)`),
  index("inventory_levels_location_idx").on(t.dealerId, t.locationId),
  check("inventory_levels_quantities_ck", sql`${t.quantityOnHand} >= 0 and ${t.quantityReserved} >= 0 and ${t.quantityNonSellable} >= 0 and ${t.quantityNonSellable} <= ${t.quantityOnHand} and ${t.averageUnitCost} >= 0`),
]);
export const inventoryTransactionsTable = pgTable("inventory_transactions", {
  ...stockScope(), type: text("type").notNull(), quantityDelta: integer("quantity_delta").notNull(),
  nonSellableDelta: integer("non_sellable_delta").notNull().default(0),
  referenceType: text("reference_type").notNull(), referenceId: text("reference_id").notNull(),
  unitCostAtTransaction: doublePrecision("unit_cost_at_transaction").notNull(),
  valueDelta: doublePrecision("value_delta").notNull(), createdBy: integer("created_by"),
  createdAt: createdAt(), idempotencyKey: text("idempotency_key"), notes: text("notes"),
}, t => [
  index("inventory_transactions_history_idx").on(t.dealerId, t.partId, t.locationId, t.createdAt),
  index("inventory_transactions_reference_idx").on(t.dealerId, t.referenceType, t.referenceId),
  uniqueIndex("inventory_transactions_idempotency_uq").on(t.dealerId, t.idempotencyKey),
  check("inventory_transactions_type_ck", sql`${t.type} in ('receipt','issue','transfer','adjustment','cycle_count','return','opening')`),
  check("inventory_transactions_cost_ck", sql`${t.unitCostAtTransaction} >= 0`),
]);
export const inventoryCostLayersTable = pgTable("inventory_cost_layers", {
  ...stockScope(), receiptTransactionId: integer("receipt_transaction_id").notNull().references(() => inventoryTransactionsTable.id),
  quantityReceived: integer("quantity_received").notNull(), quantityRemaining: integer("quantity_remaining").notNull(),
  unitCost: doublePrecision("unit_cost").notNull(), nonSellable: boolean("non_sellable").notNull().default(false),
  createdAt: createdAt(),
}, t => [
  index("inventory_cost_layers_fifo_idx").on(t.dealerId, t.partId, t.locationId, t.createdAt),
  check("inventory_cost_layers_quantities_ck", sql`${t.quantityReceived} > 0 and ${t.quantityRemaining} >= 0 and ${t.quantityRemaining} <= ${t.quantityReceived} and ${t.unitCost} >= 0`),
]);
export const inventoryCostConsumptionsTable = pgTable("inventory_cost_consumptions", {
  ...identity(), layerId: integer("layer_id").notNull().references(() => inventoryCostLayersTable.id),
  transactionId: integer("transaction_id").notNull().references(() => inventoryTransactionsTable.id),
  quantity: integer("quantity").notNull(), unitCost: doublePrecision("unit_cost").notNull(), createdAt: createdAt(),
}, t => [
  index("inventory_cost_consumptions_history_idx").on(t.dealerId, t.layerId, t.createdAt),
  uniqueIndex("inventory_cost_consumptions_tx_layer_uq").on(t.dealerId, t.transactionId, t.layerId),
  check("inventory_cost_consumptions_values_ck", sql`${t.quantity} > 0 and ${t.unitCost} >= 0`),
]);
export const inventoryHoldsTable = pgTable("inventory_holds", {
  ...stockScope(), quantity: integer("quantity").notNull(), referenceType: text("reference_type").notNull(),
  referenceId: text("reference_id").notNull(), status: text("status").notNull().default("active"),
  backorderRisk: boolean("backorder_risk").notNull().default(false),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull().default(sql`now() + interval '7 days'`),
  releasedAt: timestamp("released_at", { withTimezone: true }), createdAt: createdAt(), createdBy: integer("created_by"),
}, t => [
  index("inventory_holds_reference_idx").on(t.dealerId, t.referenceType, t.referenceId),
  index("inventory_holds_expiry_idx").on(t.dealerId, t.status, t.expiresAt),
  check("inventory_holds_values_ck", sql`${t.quantity} > 0 and ${t.status} in ('active','released','consumed')`),
]);
export const inventoryCycleCountsTable = pgTable("inventory_cycle_counts", {
  ...identity(), locationId: integer("location_id").notNull().references(() => inventoryLocationsTable.id),
  binId: integer("bin_id").references(() => inventoryBinsTable.id), category: text("category"),
  status: text("status").notNull().default("in_progress"), startedBy: integer("started_by"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }), approvedBy: integer("approved_by"),
}, t => [
  index("inventory_cycle_counts_scope_idx").on(t.dealerId, t.locationId, t.status),
  check("inventory_cycle_counts_status_ck", sql`${t.status} in ('in_progress','pending_approval','completed','cancelled')`),
]);
export const inventoryCycleCountLinesTable = pgTable("inventory_cycle_count_lines", {
  ...identity(), cycleCountId: integer("cycle_count_id").notNull().references(() => inventoryCycleCountsTable.id),
  partId: integer("part_id").notNull().references(() => partsTable.id), binId: integer("bin_id").references(() => inventoryBinsTable.id),
  expectedQty: integer("expected_qty").notNull(), countedQty: integer("counted_qty"), variance: integer("variance"),
  approvedBy: integer("approved_by"), transactionId: integer("transaction_id").references(() => inventoryTransactionsTable.id),
}, t => [
  uniqueIndex("inventory_cycle_count_lines_scope_uq").on(t.dealerId, t.cycleCountId, t.partId, sql`coalesce(${t.binId}, 0)`),
  check("inventory_cycle_count_lines_qty_ck", sql`${t.expectedQty} >= 0 and (${t.countedQty} is null or ${t.countedQty} >= 0)`),
]);
export const partPricingPoliciesTable = pgTable("part_pricing_policies", {
  ...identity(), category: text("category"), markupFactor: doublePrecision("markup_factor").notNull().default(1),
  reconciliationTolerancePercent: doublePrecision("reconciliation_tolerance_percent").notNull().default(2),
  holdExpiryDays: integer("hold_expiry_days").notNull().default(7),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("part_pricing_policies_category_uq").on(t.dealerId, sql`coalesce(${t.category}, '')`),
  check("part_pricing_policies_values_ck", sql`${t.markupFactor} >= 0 and ${t.reconciliationTolerancePercent} >= 0 and ${t.holdExpiryDays} > 0`),
]);
export const partImportJobsTable = pgTable("part_import_jobs", {
  ...identity(), status: text("status").notNull().default("pending"), mode: text("mode").notNull().default("reject"),
  fileName: text("file_name").notNull(), columnMapping: jsonb("column_mapping").notNull().default({}),
  rows: jsonb("rows").$type<Record<string, unknown>[]>().notNull().default([]),
  errors: jsonb("errors").$type<unknown[]>().notNull().default([]),
  processedRows: integer("processed_rows").notNull().default(0), totalRows: integer("total_rows").notNull().default(0),
  createdBy: integer("created_by"), createdAt: createdAt(), startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }), errorMessage: text("error_message"),
}, t => [
  index("part_import_jobs_queue_idx").on(t.dealerId, t.status, t.createdAt),
  check("part_import_jobs_status_ck", sql`${t.status} in ('pending','validating','validated','invalid','queued','processing','completed','failed') and ${t.mode} in ('reject','upsert')`),
  check("part_import_jobs_progress_ck", sql`${t.processedRows} >= 0 and ${t.totalRows} >= 0 and ${t.processedRows} <= ${t.totalRows}`),
]);
export const partReconciliationsTable = pgTable("part_reconciliations", {
  ...identity(), purchaseOrderId: integer("purchase_order_id").notNull().references(() => purchaseOrdersTable.id),
  purchaseOrderLineId: integer("purchase_order_line_id").notNull().references(() => purchaseOrderLinesTable.id),
  receiptId: integer("receipt_id").references(() => purchaseOrderReceiptsTable.id),
  invoiceNumber: text("invoice_number"), invoiceQuantity: integer("invoice_quantity"),
  invoiceUnitCost: doublePrecision("invoice_unit_cost"), receivedQuantity: integer("received_quantity").notNull(),
  tolerancePercent: doublePrecision("tolerance_percent").notNull().default(2),
  status: text("status").notNull().default("pending"), resolution: text("resolution"), notes: text("notes"),
  resolvedBy: integer("resolved_by"), resolvedAt: timestamp("resolved_at", { withTimezone: true }), createdAt: createdAt(),
}, t => [
  index("part_reconciliations_queue_idx").on(t.dealerId, t.status, t.purchaseOrderId),
  check("part_reconciliations_values_ck", sql`${t.receivedQuantity} >= 0 and ${t.tolerancePercent} >= 0 and (${t.invoiceQuantity} is null or ${t.invoiceQuantity} >= 0) and (${t.invoiceUnitCost} is null or ${t.invoiceUnitCost} >= 0)`),
  check("part_reconciliations_status_ck", sql`${t.status} in ('pending','matched','flagged','resolved')`),
]);
export const partNotificationDeliveriesTable = pgTable("part_notification_deliveries", {
  locationId: integer("location_id"),
  ...identity(), recipientId: integer("recipient_id").notNull(), channel: text("channel").notNull(),
  type: text("type").notNull(), referenceType: text("reference_type").notNull(), referenceId: text("reference_id").notNull(),
  status: text("status").notNull().default("pending"), attempts: integer("attempts").notNull().default(0),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}), errorMessage: text("error_message"),
  sentAt: timestamp("sent_at", { withTimezone: true }), createdAt: createdAt(),
}, t => [
  uniqueIndex("part_notification_deliveries_dedupe_uq").on(t.dealerId, t.recipientId, t.channel, t.type, t.referenceType, t.referenceId),
  index("part_notification_deliveries_queue_idx").on(t.dealerId, t.status),
  check("part_notification_deliveries_values_ck", sql`${t.attempts} >= 0 and ${t.channel} in ('internal','sms','email') and ${t.status} in ('pending','sending','sent','failed')`),
]);