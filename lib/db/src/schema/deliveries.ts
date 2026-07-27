import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Ordered delivery workflow steps — advanced strictly in sequence.
 * Canonical 9-step delivery SAGA (NC-3 / R2.9): EXACTLY 9 steps.
 */
export const DELIVERY_STEPS = [
  "sales_order",
  "pdi_checklist",
  "registration",
  "insurance",
  "invoice",
  "appointment",
  "delivery",
  "signature",
  "feedback",
] as const;
export type DeliveryStep = (typeof DELIVERY_STEPS)[number];

export const DELIVERY_STEP_LABELS: Record<DeliveryStep, string> = {
  sales_order: "Sales Order",
  pdi_checklist: "PDI Checklist",
  registration: "Registration",
  insurance: "Insurance",
  invoice: "Invoice",
  appointment: "Delivery Appointment",
  delivery: "Vehicle Delivery",
  signature: "Customer Signature",
  feedback: "Feedback",
};

export const DELIVERY_STATUSES = ["in_progress", "completed"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const deliveryStepStateSchema = z.object({
  key: z.enum(DELIVERY_STEPS),
  label: z.string(),
  status: z.enum(["pending", "completed"]),
  note: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional(),
  completedBy: z.string().nullable().optional(),
});
export type DeliveryStepState = z.infer<typeof deliveryStepStateSchema>;

/** Tri-state PDI (L7): every item must be pass or waived-with-reason to advance. */
export const PDI_ITEM_STATUSES = [
  "pending",
  "pass",
  "fail",
  "waived",
] as const;
export type PdiItemStatus = (typeof PDI_ITEM_STATUSES)[number];

export const pdiItemSchema = z.object({
  label: z.string(),
  status: z.enum(PDI_ITEM_STATUSES),
  waiveReason: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
});
export type PdiItem = z.infer<typeof pdiItemSchema>;

/**
 * Legacy compatibility: pdi_items rows persisted before the tri-state upgrade
 * were shaped `{ label, checked }`. Normalize any raw payload to the current
 * `{ label, status, ... }` shape so old rows never break parsing or gating.
 */
export function normalizePdiItems(items: unknown): PdiItem[] {
  if (!Array.isArray(items)) return [];
  return items.map((raw): PdiItem => {
    const parsed = pdiItemSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    const r = (raw ?? {}) as Record<string, unknown>;
    return {
      label: typeof r.label === "string" ? r.label : "PDI item",
      status: r.checked === true ? "pass" : "pending",
    };
  });
}

export const DEFAULT_PDI_ITEMS: PdiItem[] = [
  "Exterior paint & panel inspection",
  "Interior trim & upholstery check",
  "Fluid levels & leak inspection",
  "Battery / charge state verification",
  "Tyre condition & pressure",
  "Lights, indicators & horn",
  "Infotainment & electronics",
  "Brake system test",
  "Road test completed",
  "Detailing & final wash",
].map((label): PdiItem => ({ label, status: "pending" }));

/** Registration submission tracking (L7): pending → submitted → issued. */
export const REGISTRATION_STATUSES = [
  "pending",
  "submitted",
  "issued",
] as const;
export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

export function defaultDeliverySteps(): DeliveryStepState[] {
  return DELIVERY_STEPS.map((key) => ({
    key,
    label: DELIVERY_STEP_LABELS[key],
    status: "pending",
  }));
}

export const deliveriesTable = pgTable("deliveries", {
  id: serial("id").primaryKey(),
  dealerId: integer("dealer_id").notNull(),
  dealId: integer("deal_id").notNull(),
  bookingId: integer("booking_id"),
  vehicleId: integer("vehicle_id").notNull(),
  customerId: integer("customer_id"),
  customerName: text("customer_name"),
  advisorUserId: integer("advisor_user_id"),
  status: text("status").notNull().default("in_progress"),
  currentStep: text("current_step").notNull().default("sales_order"),
  steps: jsonb("steps")
    .$type<DeliveryStepState[]>()
    .notNull()
    .default([]),
  pdiItems: jsonb("pdi_items").$type<PdiItem[]>().notNull().default([]),
  appointmentAt: timestamp("appointment_at", { withTimezone: true }),
  invoiceId: integer("invoice_id"),
  signatureName: text("signature_name"),
  signatureData: text("signature_data"),
  feedbackRating: integer("feedback_rating"),
  feedbackComment: text("feedback_comment"),
  registrationNumber: text("registration_number"),
  registrationStatus: text("registration_status").notNull().default("pending"),
  registrationSubmittedAt: timestamp("registration_submitted_at", {
    withTimezone: true,
  }),
  insurancePolicy: text("insurance_policy"),
  insuranceProvider: text("insurance_provider"),
  insuranceDocId: integer("insurance_doc_id"),
  handoverSheetDocId: integer("handover_sheet_doc_id"),
  pdiWorkOrderId: integer("pdi_work_order_id"),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertDeliverySchema = createInsertSchema(deliveriesTable, {
  status: z.enum(DELIVERY_STATUSES),
  currentStep: z.enum(DELIVERY_STEPS),
  registrationStatus: z.enum(REGISTRATION_STATUSES),
  steps: z.array(deliveryStepStateSchema),
  pdiItems: z.array(pdiItemSchema),
}).omit({ dealerId: true, id: true, createdAt: true });
export type InsertDelivery = z.infer<typeof insertDeliverySchema>;
export type Delivery = typeof deliveriesTable.$inferSelect;
