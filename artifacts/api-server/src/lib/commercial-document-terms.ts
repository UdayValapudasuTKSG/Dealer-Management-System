/** User-approved wording shared by customer estimates and pre-delivery sales
 * documents. Do not apply to receipts, completed-service invoices or reports. */
export const COMMERCIAL_DOCUMENT_TERMS = [
  "Estimate only: The quoted price is based on duties, taxes, freight, and exchange rates on the quote date, and is subject to adjustment prior to delivery.",
  "Pass-through at cost: Any increases or decreases in customs duty, excise tax, VAT, levies, freight, or manufacturer prices will be passed on at cost without markup.",
  "Written notice: The buyer will receive notice and a revised invoice prior to delivery.",
] as const;

export function hasCommercialTerms(payload: Record<string, string>): boolean {
  return ["estimate", "quotation", "proforma"].includes(payload.documentType) ||
    payload.salesTermsApplicable === "true";
}
