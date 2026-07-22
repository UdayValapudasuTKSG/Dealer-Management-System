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

export const pdiItemSchema = z.object({
  label: z.string(),
  checked: z.boolean(),
});
export type PdiItem = z.infer<typeof pdiItemSchema>;

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
].map((label) => ({ label, checked: false }));

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
  insurancePolicy: text("insurance_policy"),
  insuranceProvider: text("insurance_provider"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertDeliverySchema = createInsertSchema(deliveriesTable, {
  status: z.enum(DELIVERY_STATUSES),
  currentStep: z.enum(DELIVERY_STEPS),
  steps: z.array(deliveryStepStateSchema),
  pdiItems: z.array(pdiItemSchema),
}).omit({ dealerId: true, id: true, createdAt: true });
export type InsertDelivery = z.infer<typeof insertDeliverySchema>;
export type Delivery = typeof deliveriesTable.$inferSelect;
