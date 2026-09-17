import { normalizePowertrain } from "./vehicle-compat";

/**
 * This is the only reviewed history batch that may later be acknowledged as
 * settled and handed over outside AURA. Keep this allowlist deliberately
 * source-row scoped: the batch digest alone must not make an arbitrary VIN
 * eligible for the exception.
 */
export const REVIEWED_GT_AUGUST_BATCH_KEY =
  "gt-automotive-august-2026-reviewed";
export const REVIEWED_GT_AUGUST_BATCH_FINGERPRINT =
  "b89d087d5f91ac6fc97b10f230a32286ece974d552684d564ea9200bdc203a0f";
export const REVIEWED_GT_AUGUST_APPROVED_ROWS: Readonly<
  Record<number, string>
> = Object.freeze({
  2: "LC0CE4CB7V4016852",
  3: "LC0CE4CB5V4016851",
  4: "LC0CE4CB1V4016863",
  5: "LC0CE4CB7V4016883",
  6: "LC0CE4CB9V4016867",
  7: "LC0CE4CB0V4016885",
  8: "LC0CE4CB1V4016846",
  9: "LC0CE4CB5V4016879",
  10: "LC0CE4CB2V4016869",
  11: "LC0CE4CB7V4016866",
});

function normalizedReviewedVin(value: string | null | undefined): string {
  return (value ?? "").trim().toUpperCase();
}

/**
 * Pure, fail-closed policy for the explicitly approved historical settlement
 * exception. This does not claim payment evidence or manufacture a handover
 * time; it only recognizes the user's reviewed batch facts.
 */
export function isApprovedHistoricalSettlement(input: {
  dealerId: number;
  vin: string | null | undefined;
  importMetadata: unknown;
}): boolean {
  if (input.dealerId !== 1 || !input.vin) return false;
  if (
    !input.importMetadata ||
    typeof input.importMetadata !== "object" ||
    Array.isArray(input.importMetadata)
  )
    return false;
  const metadata = input.importMetadata as Record<string, unknown>;
  const sourceRow = metadata.sourceRow;
  const vin = normalizedReviewedVin(input.vin);
  return (
    metadata.kind === "reviewed_delivery_history" &&
    metadata.batchKey === REVIEWED_GT_AUGUST_BATCH_KEY &&
    metadata.batchFingerprint === REVIEWED_GT_AUGUST_BATCH_FINGERPRINT &&
    metadata.sourceStatus === "Delivered" &&
    metadata.suppressCustomerCommunications === true &&
    metadata.paymentState === "UNRECORDED" &&
    Number.isSafeInteger(sourceRow) &&
    REVIEWED_GT_AUGUST_APPROVED_ROWS[sourceRow as number] === vin &&
    normalizedReviewedVin(
      typeof metadata.sourceVin === "string" ? metadata.sourceVin : null,
    ) === vin
  );
}

export function parseReviewedCandidateLeadId(value: string | undefined): number | null {
  const text = (value ?? "").trim();
  if (!text) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export type ReviewedImportVehicle = {
  make: string | null;
  model: string | null;
  trim: string | null;
  year: number | null;
  engineNumber: string | null;
  price: number;
  powertrain: string | null;
  bodyType: string | null;
  exteriorColor: string | null;
};

export type ReviewedImportRow = {
  sellingPrice: number;
  raw: Record<string, string>;
};

function sameText(left: string | null | undefined, right: string | null | undefined): boolean {
  return (left ?? "").trim().toLocaleLowerCase() === (right ?? "").trim().toLocaleLowerCase();
}

export function matchesReviewedVehicle(
  vehicle: ReviewedImportVehicle,
  row: ReviewedImportRow,
  input: { modelYear: number; vehicleMake: string; powertrain: string; bodyType: string },
): boolean {
  return (
    sameText(vehicle.make, input.vehicleMake) &&
    sameText(vehicle.model, row.raw["Model"]) &&
    sameText(vehicle.trim, row.raw["Version"]) &&
    vehicle.year === input.modelYear &&
    sameText(vehicle.engineNumber, row.raw["Engine No"]) &&
    vehicle.price === row.sellingPrice &&
    normalizePowertrain(vehicle.powertrain) ===
      normalizePowertrain(input.powertrain) &&
    sameText(vehicle.bodyType, input.bodyType) &&
    (!(row.raw["Exterior"] ?? "").trim() || sameText(vehicle.exteriorColor, row.raw["Exterior"]))
  );
}

export type ReusableCommittedDeal = {
  vehicleId: number;
  customerId: number | null;
  leadId: number | null;
  stage: string;
  vehiclePrice: number;
  otdPrice: number;
};

export function isReusableCommittedDeal(
  deal: ReusableCommittedDeal,
  vehicleId: number,
  customerId: number,
  leadId: number,
  sellingPrice: number,
): boolean {
  return (
    deal.stage === "committed" &&
    deal.vehicleId === vehicleId &&
    deal.customerId === customerId &&
    deal.leadId === leadId &&
    deal.vehiclePrice === sellingPrice &&
    deal.otdPrice === sellingPrice
  );
}

export function identityImportPlan(
  candidateLeadIds: number[],
  candidateCustomerIds: number[],
  candidateDealIds: number[],
  verifiedReplay: boolean,
) {
  const id = (candidates: number[]) => candidates.length === 1 ? candidates[0]! : null;
  return {
    leadAction: candidateLeadIds.length ? "reuse_lead" as const : "create_lead" as const,
    leadId: id(candidateLeadIds),
    customerAction: candidateCustomerIds.length ? "reuse_customer" as const : "create_customer" as const,
    customerId: id(candidateCustomerIds),
    dealAction: candidateDealIds.length ? "reuse_deal" as const : "create_deal" as const,
    dealId: id(candidateDealIds),
    requiresIdentityConfirmation: !verifiedReplay &&
      (candidateLeadIds.length > 0 || candidateCustomerIds.length > 0 || candidateDealIds.length > 0),
  };
}

export type InvoiceFinanceState = {
  amount: number;
  status: string;
  paymentCount: number;
  taxLines: unknown;
};

export function hasUnsafeReusableFinance(
  finalInvoices: InvoiceFinanceState[],
  sellingPrice: number,
): boolean {
  return finalInvoices.length > 1 || finalInvoices.some((invoice) =>
    invoice.amount !== sellingPrice ||
    invoice.status !== "issued" ||
    invoice.paymentCount !== 0 ||
    !Array.isArray(invoice.taxLines) ||
    invoice.taxLines.length !== 0,
  );
}

/** Scoped lead provenance suppression never mutates customer consent. */
export function suppressesReviewedImportedLead(metadata: unknown): boolean {
  return !!metadata && typeof metadata === "object" &&
    (metadata as Record<string, unknown>).suppressCustomerCommunications === true &&
    (metadata as Record<string, unknown>).suppressSalesAutomation === true;
}

/** Import suppression is keyed to a concrete lead reference, never an email
 * address. A different lead/customer sharing an address remains unaffected. */
export function isExplicitLeadOutboxSuppressed(
  leadId: number | null | undefined,
  metadata: unknown,
): boolean {
  return leadId != null && suppressesReviewedImportedLead(metadata);
}

/** Legacy outbox rows without a lead id need an unambiguous customer match.
 * An ambiguous match fails closed, but only for the legacy row itself; newly
 * queued rows carrying an explicit lead id remain scoped to that lead. */
export type LegacyReviewedOutboxDisposition =
  | "allow"
  | "suppress"
  | "cancel_ambiguous";

/**
 * Legacy rows lacked a lead id, so they can only be suppressed when they are
 * demonstrably old sales/delivery automation that predates the reviewed
 * conversion. This is intentionally a positive list: service, collision and
 * later lifecycle communication must not inherit a historical-sale fence just
 * because it shares a customer or recipient with an imported record.
 */
export const PRE_IMPORT_SALES_DELIVERY_TEMPLATES = [
  "lead_received",
  "vehicle_quote",
  "test_drive_invite",
  "test_drive_confirmation",
  "lead_assignment",
  "finance_processing",
  "finance_approved",
  "vehicle_booking",
  "payment_reminder",
  "payment_received",
  "refund_confirmation",
  "delivery_schedule",
  "delivery_advisor_assigned",
  "delivery_confirmation",
  "feedback_request",
  "thank_you",
  "outreach",
  "testdrive.reminder.24h",
  "reservation.pending",
  "invoice.generated",
  "document.request.customer",
  "refund.customer",
  "delivery.ready",
  "warranty.document",
] as const;

export function isPreImportSalesDeliveryTemplate(template: string): boolean {
  return (PRE_IMPORT_SALES_DELIVERY_TEMPLATES as readonly string[]).includes(
    template,
  );
}

function importedAt(metadata: unknown): Date | null {
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>).importedAt;
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function legacyReviewedOutboxDisposition(
  candidates: Array<{ importMetadata: unknown }>,
  item?: { template: string; createdAt: Date | null | undefined },
): LegacyReviewedOutboxDisposition {
  // Do not infer provenance for a newly queued or context-less row. Explicit
  // lead-id rows are handled separately and remain lead-scoped.
  if (
    !item ||
    !item.createdAt ||
    !isPreImportSalesDeliveryTemplate(item.template)
  ) {
    return "allow";
  }
  const suppressingCandidates = candidates.filter((candidate) => {
    const convertedAt = importedAt(candidate.importMetadata);
    return (
      suppressesReviewedImportedLead(candidate.importMetadata) &&
      convertedAt != null &&
      item.createdAt! < convertedAt
    );
  });
  if (suppressingCandidates.length === 0) return "allow";
  if (candidates.length === 0) return "allow";
  if (candidates.length > 1) {
    return "cancel_ambiguous";
  }
  return "suppress";
}

/**
 * Advisory-lock identities shared by the reviewed-history importer and the
 * outbox workers. Explicit messages are fenced by their concrete lead id.
 * Older identity-less messages are fenced only by the identities that their
 * legacy lookup is allowed to inspect; this is a serialization aid, not an
 * address-based suppression rule.
 */
export function reviewedOutboxCommunicationLockKeys(input: {
  dealerId: number;
  leadId?: number | null;
  customerId?: number | null;
  email?: string | null;
  emails?: Array<string | null | undefined>;
  whatsappPhones?: Array<string | null | undefined>;
}): string[] {
  const keys = new Set<string>();
  if (input.leadId != null) {
    keys.add(`reviewed-outbox:${input.dealerId}:lead:${input.leadId}`);
  }
  if (input.customerId != null) {
    keys.add(
      `reviewed-outbox:${input.dealerId}:legacy:customer:${input.customerId}`,
    );
  }
  for (const value of [input.email, ...(input.emails ?? [])]) {
    const email = value?.trim().toLowerCase();
    if (email) {
      keys.add(`reviewed-outbox:${input.dealerId}:legacy:email:${email}`);
    }
  }
  for (const phone of input.whatsappPhones ?? []) {
    const digits = phone?.replace(/\D/g, "");
    if (digits) {
      keys.add(
        `reviewed-outbox:${input.dealerId}:legacy:whatsapp:${digits}`,
      );
    }
  }
  // Every caller takes multi-key locks in a canonical order.
  return [...keys].sort();
}

/** A missing VIN will be inserted during the import and is therefore
 * allocatable; only an already persisted non-available unit blocks creation. */
export function canCreateCommittedDealForVehicle(
  existingVehicle: { status: string } | null | undefined,
): boolean {
  return existingVehicle == null || existingVehicle.status === "available";
}

export function requiresApplyIdentityConfirmation(
  reviewRow: { requiresIdentityConfirmation: boolean },
): boolean {
  return reviewRow.requiresIdentityConfirmation;
}
