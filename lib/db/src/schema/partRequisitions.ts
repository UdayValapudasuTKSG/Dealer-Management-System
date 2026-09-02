import {
  date,
  doublePrecision,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { jobCardsTable } from "./workshop";
import { partsTable } from "./workshop";

export const PART_REQUISITION_STATUSES = [
  "submitted",
  "approved",
  "rejected",
  "ordered",
  "partially_fulfilled",
  "fulfilled",
  "cancelled",
] as const;
export const PART_REQUISITION_URGENCIES = ["routine", "urgent", "vehicle_down"] as const;
export const PART_REQUISITION_LINE_SOURCES = ["INTERNAL", "EXTERNAL"] as const;

export const partRequisitionsTable = pgTable(
  "part_requisitions",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    serviceOrderId: integer("service_order_id").notNull(),
    jobCardId: integer("job_card_id")
      .notNull()
      .references(() => jobCardsTable.id, { onDelete: "cascade" }),
    requesterUserId: integer("requester_user_id"),
    requesterName: text("requester_name").notNull(),
    status: text("status").notNull().default("submitted"),
    urgency: text("urgency").notNull().default("routine"),
    needBy: date("need_by", { mode: "string" }),
    notes: text("notes"),
    decisionReason: text("decision_reason"),
    decidedByUserId: integer("decided_by_user_id"),
    decidedByName: text("decided_by_name"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    orderedByUserId: integer("ordered_by_user_id"),
    orderedByName: text("ordered_by_name"),
    orderedAt: timestamp("ordered_at", { withTimezone: true }),
    orderReference: text("order_reference"),
    fulfilledByUserId: integer("fulfilled_by_user_id"),
    fulfilledByName: text("fulfilled_by_name"),
    fulfilledAt: timestamp("fulfilled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("part_requisitions_dealer_status_idx").on(t.dealerId, t.status),
    index("part_requisitions_dealer_job_card_idx").on(t.dealerId, t.jobCardId),
    index("part_requisitions_dealer_service_order_idx").on(t.dealerId, t.serviceOrderId),
  ],
);

export const partRequisitionLinesTable = pgTable(
  "part_requisition_lines",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    requisitionId: integer("requisition_id")
      .notNull()
      .references(() => partRequisitionsTable.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    partId: integer("part_id").references(() => partsTable.id),
    skuSnapshot: text("sku_snapshot"),
    descriptionSnapshot: text("description_snapshot").notNull(),
    supplierSnapshot: text("supplier_snapshot"),
    quantity: integer("quantity").notNull(),
    fulfilledQuantity: integer("fulfilled_quantity").notNull().default(0),
    unitCost: doublePrecision("unit_cost").notNull().default(0),
    unitPrice: doublePrecision("unit_price").notNull().default(0),
    taxCost: doublePrecision("tax_cost").notNull().default(0),
    freightCost: doublePrecision("freight_cost").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("part_requisition_lines_req_idx").on(t.dealerId, t.requisitionId),
    index("part_requisition_lines_part_idx").on(t.dealerId, t.partId),
  ],
);

export const partRequisitionFulfillmentsTable = pgTable(
  "part_requisition_fulfillments",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    requisitionId: integer("requisition_id")
      .notNull()
      .references(() => partRequisitionsTable.id, { onDelete: "cascade" }),
    lineId: integer("line_id")
      .notNull()
      .references(() => partRequisitionLinesTable.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    quantity: integer("quantity").notNull(),
    jobCardPartId: integer("job_card_part_id"),
    externalJobCardPartId: integer("external_job_card_part_id"),
    fulfilledByUserId: integer("fulfilled_by_user_id"),
    fulfilledByName: text("fulfilled_by_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("part_req_fulfillment_idempotency_unique").on(
      t.dealerId,
      t.requisitionId,
      t.lineId,
      t.idempotencyKey,
    ),
  ],
);

export const externalJobCardPartsTable = pgTable(
  "external_job_card_parts",
  {
    id: serial("id").primaryKey(),
    dealerId: integer("dealer_id").notNull(),
    jobCardId: integer("job_card_id")
      .notNull()
      .references(() => jobCardsTable.id, { onDelete: "cascade" }),
    requisitionLineId: integer("requisition_line_id")
      .notNull()
      .references(() => partRequisitionLinesTable.id),
    fulfillmentId: integer("fulfillment_id").notNull(),
    description: text("description").notNull(),
    supplierSnapshot: text("supplier_snapshot"),
    quantity: integer("quantity").notNull(),
    unitCost: doublePrecision("unit_cost").notNull().default(0),
    unitPrice: doublePrecision("unit_price").notNull().default(0),
    taxCost: doublePrecision("tax_cost").notNull().default(0),
    freightCost: doublePrecision("freight_cost").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("external_job_card_parts_fulfillment_unique").on(t.fulfillmentId),
    index("external_job_card_parts_card_idx").on(t.dealerId, t.jobCardId),
  ],
);

export const insertPartRequisitionSchema = createInsertSchema(partRequisitionsTable, {
  status: z.enum(PART_REQUISITION_STATUSES),
  urgency: z.enum(PART_REQUISITION_URGENCIES),
}).omit({ id: true, createdAt: true, updatedAt: true });
export const insertPartRequisitionLineSchema = createInsertSchema(partRequisitionLinesTable, {
  source: z.enum(PART_REQUISITION_LINE_SOURCES),
}).omit({ id: true, createdAt: true });
export type PartRequisition = typeof partRequisitionsTable.$inferSelect;
export type PartRequisitionLine = typeof partRequisitionLinesTable.$inferSelect;
export type PartRequisitionFulfillment = typeof partRequisitionFulfillmentsTable.$inferSelect;
export type ExternalJobCardPart = typeof externalJobCardPartsTable.$inferSelect;