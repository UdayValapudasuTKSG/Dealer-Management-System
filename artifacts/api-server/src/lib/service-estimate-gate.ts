/**
 * Invoice issuance for customer-pay work has two distinct attestations: the
 * customer must approve the currently-priced estimate, and authenticated
 * service staff must acknowledge receipt of that exact customer decision.
 * These attestations are commercial evidence, not authorization to perform
 * workshop work or record technician time.
 */
export type EstimateGateCard = {
  payType: string;
  quoteTotal: number;
  estimateVersion: number;
  estimateApprovedVersion: number | null;
  estimateStaffAcknowledgedVersion: number | null;
  estimateStaffAcknowledgedDecisionId: number | null;
};

export function hasCurrentCustomerEstimateApproval(
  card: Pick<
    EstimateGateCard,
    "payType" | "quoteTotal" | "estimateVersion" | "estimateApprovedVersion"
  >,
): boolean {
  return (
    card.payType !== "customer" ||
    card.quoteTotal <= 0 ||
    card.estimateApprovedVersion === card.estimateVersion
  );
}

export function hasCurrentChargeableWorkAuthorization(
  card: EstimateGateCard,
): boolean {
  return (
    card.payType !== "customer" ||
    card.quoteTotal <= 0 ||
    (hasCurrentCustomerEstimateApproval(card) &&
      card.estimateStaffAcknowledgedVersion === card.estimateVersion &&
      card.estimateStaffAcknowledgedDecisionId != null)
  );
}

/** Explicitly clear every acknowledgement attribute on quote/decision change. */
export const clearEstimateStaffAcknowledgement = {
  estimateStaffAcknowledgedVersion: null,
  estimateStaffAcknowledgedDecisionId: null,
  estimateStaffAcknowledgedByUserId: null,
  estimateStaffAcknowledgedByName: null,
  estimateStaffAcknowledgedAt: null,
} as const;