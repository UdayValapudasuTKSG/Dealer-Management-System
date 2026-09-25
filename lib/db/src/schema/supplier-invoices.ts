import { sql } from "drizzle-orm";
import { pgTable, serial, integer, text, date, bigint, timestamp, jsonb, uniqueIndex, index, primaryKey, check } from "drizzle-orm/pg-core";
import { suppliersTable, purchaseOrdersTable, purchaseOrderLinesTable, partsTable } from "./workshop";
import { inventoryLocationsTable, inventoryCostLayersTable } from "./parts-inventory";
const minor = (name: string) => bigint(name, { mode: "bigint" }).notNull();
export const supplierInvoicesTable = pgTable("supplier_invoices", {
  id: serial("id").primaryKey(), dealerId: integer("dealer_id").notNull(),
  locationId: integer("location_id").notNull().references(()=>inventoryLocationsTable.id),
  supplierId: integer("supplier_id").notNull().references(()=>suppliersTable.id),
  poId: integer("po_id").notNull().references(()=>purchaseOrdersTable.id),
  invoiceNumber: text("invoice_number").notNull(), invoiceDate: date("invoice_date").notNull(),
  objectPath: text("object_path").notNull(), fileName: text("file_name").notNull(),
  subtotalMinor: minor("subtotal_minor"), shippingMinor: minor("shipping_minor"), dutiesMinor: minor("duties_minor"),
  taxMinor: minor("tax_minor"), totalMinor: minor("total_minor"), toleranceBps: integer("tolerance_bps").notNull().default(0),
  status: text("status").notNull().default("pending"), createdBy: integer("created_by").notNull(),
  createdAt: timestamp("created_at",{withTimezone:true}).notNull().defaultNow(),
  reconciledBy: integer("reconciled_by"), reconciledAt: timestamp("reconciled_at",{withTimezone:true}),
},t=>[
  uniqueIndex("supplier_invoice_number_uq").on(t.dealerId,t.supplierId,sql`lower(trim(${t.invoiceNumber}))`),
  index("supplier_invoice_po_idx").on(t.dealerId,t.poId,t.status),
  check("supplier_invoice_total_ck",sql`${t.totalMinor}=${t.subtotalMinor}+${t.shippingMinor}+${t.dutiesMinor}+${t.taxMinor}`),
]);
export const supplierInvoiceLinesTable = pgTable("supplier_invoice_lines", {
  id:serial("id").primaryKey(), invoiceId:integer("invoice_id").notNull().references(()=>supplierInvoicesTable.id),
  poLineId:integer("po_line_id").references(()=>purchaseOrderLinesTable.id),partNumber:text("part_number").notNull(),
  description:text("description").notNull(),quantity:integer("quantity").notNull(),unitCostMinor:minor("unit_cost_minor"),
  allocatedMinor:bigint("allocated_minor",{mode:"bigint"}),matchStatus:jsonb("match_status").notNull().default([]),
  acceptedReason:text("accepted_reason"),acceptedBy:integer("accepted_by"),
  acceptedAt:timestamp("accepted_at",{withTimezone:true}),acceptedSnapshot:jsonb("accepted_snapshot"),
},t=>[uniqueIndex("supplier_invoice_line_once_uq").on(t.invoiceId,t.poLineId)]);
export const supplierInvoicePartCostsTable = pgTable("supplier_invoice_part_costs", {
  dealerId:integer("dealer_id").notNull(),partId:integer("part_id").notNull().references(()=>partsTable.id),
  lastCostMinor:minor("last_cost_minor"),invoiceId:integer("invoice_id").notNull().references(()=>supplierInvoicesTable.id),
  updatedAt:timestamp("updated_at",{withTimezone:true}).notNull().defaultNow(),
},t=>[primaryKey({columns:[t.dealerId,t.partId]})]);
export const supplierInvoiceCostAllocationsTable = pgTable("supplier_invoice_cost_allocations", {
  id:serial("id").primaryKey(),invoiceLineId:integer("invoice_line_id").notNull().references(()=>supplierInvoiceLinesTable.id),
  layerId:integer("layer_id").notNull().references(()=>inventoryCostLayersTable.id),quantity:integer("quantity").notNull(),
  landedMinor:minor("landed_minor"),quantityRemainingAtReconcile:integer("quantity_remaining_at_reconcile").notNull(),
},t=>[uniqueIndex("supplier_invoice_cost_allocation_uq").on(t.invoiceLineId,t.layerId)]);