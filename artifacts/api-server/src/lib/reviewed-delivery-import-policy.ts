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
    sameText(vehicle.powertrain, input.powertrain) &&
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