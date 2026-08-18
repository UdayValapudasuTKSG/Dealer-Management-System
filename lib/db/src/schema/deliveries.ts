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
  "warranty",
  "feedback",
] as const;
export type DeliveryStep = (typeof DELIVERY_STEPS)[number];

export const DELIVERY_STEP_LABELS: Record<DeliveryStep, string> = {
  sales_order: "Sales Order",
  pdi_checklist: "PDI Checklist",
  registration: "Registration",
  insurance: "Insurance",
  invoice: "Invoice",
  appointment: "Expected Delivery Date",
  warranty: "Warranty Documents",
  delivery: "Vehicle Delivery",
  signature: "Customer Signature",
  feedback: "Feedback",
};

export const DELIVERY_STATUSES = [
  "in_progress",
  "completed",
  "cancelled",
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const deliveryStepStateSchema = z.object({
  key: z.enum(DELIVERY_STEPS),
  label: z.string(),
  status: z.enum(["pending", "completed", "skipped"]),
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

/**
 * Legacy compatibility: deliveries created before a step existed (e.g. the
 * warranty step added between appointment and delivery) persisted a steps
 * array without it. Splice any missing canonical step into its canonical
 * position as pending so old workflows pick the new step up seamlessly.
 */
export function normalizeDeliverySteps(
  steps: DeliveryStepState[],
): DeliveryStepState[] {
  const present = new Set(steps.map((s) => s.key));
  const missing = DELIVERY_STEPS.filter((k) => !present.has(k));
  // Labels are persisted per delivery; refresh them so renamed steps (e.g.
  // "Delivery Appointment" → "Expected Delivery Date") show the current
  // wording on old workflows too.
  const relabeled = steps.map((s) =>
    DELIVERY_STEP_LABELS[s.key] && s.label !== DELIVERY_STEP_LABELS[s.key]
      ? { ...s, label: DELIVERY_STEP_LABELS[s.key] }
      : s,
  );
  const out = [...relabeled];
  for (const key of missing) {
    const idx = DELIVERY_STEPS.indexOf(key);
    // Insert after the last present step that canonically precedes it.
    let insertAt = 0;
    for (let i = 0; i < out.length; i++) {
      if (DELIVERY_STEPS.indexOf(out[i]!.key) < idx) insertAt = i + 1;
    }
    out.splice(insertAt, 0, {
      key,
      label: DELIVERY_STEP_LABELS[key],
      status: "pending",
    });
  }
  // Steps can be REORDERED between releases (e.g. warranty moved after
  // delivery). Persisted arrays keep their creation-time order, so sort into
  // the current canonical order — statuses travel with their step.
  return out
    .slice()
    .sort(
      (a, b) => DELIVERY_STEPS.indexOf(a.key) - DELIVERY_STEPS.indexOf(b.key),
    );
}

/**
 * The actionable step for an in-flight delivery. Persisted `currentStep`
 * pointers can go stale when the canonical step ORDER changes between
 * releases (e.g. a row saved "warranty" as current while "delivery" — now
 * earlier — is still pending). The first pending step in canonical order is
 * always the true pointer.
 */
export function effectiveCurrentStep(
  steps: DeliveryStepState[],
  fallback: DeliveryStep,
): DeliveryStep {
  const firstPending = steps.find((s) => s.status === "pending");
  return firstPending ? firstPending.key : fallback;
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
  warrantySignatureName: text("warranty_signature_name"),
  warrantySignatureData: text("warranty_signature_data"),
  feedbackRating: integer("feedback_rating"),
  feedbackComment: text("feedback_comment"),
  registrationNumber: text("registration_number"),
  registrationStatus: text("registration_status").notNull().default("pending"),
  registrationSubmittedAt: timestamp("registration_submitted_at", {
    withTimezone: true,
  }),
  insurancePolicy: text("insurance_policy"),
  /** Manual corrections shown on the printed handover form (PDF). Keys:
   *  customerAddress, customerEmail, customerPhone, salesperson, date,
   *  invoiceNumber, make, model, vin, mileage, keyNumber, stockNumber. */
  handoverOverrides: jsonb("handover_overrides")
    .$type<Record<string, string>>()
    .notNull()
    .default({}),
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
