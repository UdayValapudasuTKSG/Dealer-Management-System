import type { SalesAccountingConfigData, SalesAccountingLine } from "@workspace/db";
import { normalizeModelKey } from "@workspace/db";

/**
 * Pure policy for operational sales finance requests. Amounts are integer
 * cents throughout. Output separates:
 *  - `lines`: exact DR/CR the posting will make (immutable once submitted)
 *  - `blockers`: fixable preconditions (mapping, validation, dependency) that
 *     prevent approval until resolved and resubmitted
 *  - `policyBlocks`: unapproved business policy (advance VAT, financier
 *     transfer, supplier party). These requests are stored as `blocked` and
 *     can never be approved by this release.
 */
export type RequestKind = "invoice" | "payment" | "expense";
export type ExpenseCategory = "registration" | "fuel" | "detailing";
export type FinancePolicyInput = {
  paymentMethod?: string | null;
  kind: RequestKind;
  amountCents: number;
  category?: ExpenseCategory | null;
  sourceId?: string | null;
  payerType?: "customer" | "financier" | null;
  billingTreatment?: "dealer_paid" | "customer_billed" | null;
  customerChargeCents?: number | null;
  reference: string;
};
export type FinancePolicyContext = {
  advancePolicy?: "final_invoice_14";
  advanceApplications?: { requestId: number; amountCents: number }[];
  fullSaleAmountCents?: number;
  finalSaleStarted?: boolean;
  unresolvedAdvance?: boolean;
  configValid: boolean;
  vehicle?: { make: string; model: string; dutyFree: boolean; vin: string | null } | null;
  dealStage?: string;
  /** Active, unexpired reservation of this exact VIN for this deal. */
  hasInvoiceReservation?: boolean;
  invoice?: { kind: string; status: string; amountCents: number; taxCents: number } | null;
  invoiceOutstandingCents?: number;
  invoicePosted?: boolean;
  legacyHeld?: boolean;
};
export type FinancePolicyResult = {
  lines: SalesAccountingLine[];
  blockers: string[];
  policyBlocks: string[];
  debitCents: number;
  creditCents: number;
  chargeNetCents: number;
  chargeVatCents: number;
};

export const ADVANCE_VAT_BLOCK =
  "Advance VAT policy is pending Finance approval. Deposit/advance postings stay blocked; nothing was posted.";
export const FINANCIER_BLOCK =
  "Financier settlement against a distinct financed receivable needs an established transfer policy. This release keeps it blocked.";
export const SUPPLIER_PARTY_BLOCK =
  "Supplier-funded expenses need an actual supplier party; payable GL rows are never sent without one. Use a bank, cash or float source.";

export function splitVat(grossOrNetCents: number, ratePct: number, includesVat: boolean) {
  if (ratePct <= 0) return { net: grossOrNetCents, vat: 0 };
  if (includesVat) {
    const net = Math.round((grossOrNetCents * 100) / (100 + ratePct));
    return { net, vat: grossOrNetCents - net };
  }
  return { net: grossOrNetCents, vat: Math.round((grossOrNetCents * ratePct) / 100) };
}

export function evaluateFinanceRequest(
  config: SalesAccountingConfigData,
  input: FinancePolicyInput,
  ctx: FinancePolicyContext,
): FinancePolicyResult {
  const lines: SalesAccountingLine[] = [];
  const blockers: string[] = [];
  const policyBlocks: string[] = [];
  const account = (key: string, label: string) => {
    const v = config.accounts.find((a) => a.key === key)?.account.trim() ?? "";
    if (!v) blockers.push(`Configure the ${label} account in Finance mappings.`);
    return v;
  };
  const line = (acct: string, debitCents: number, creditCents: number, purpose: string) => {
    if (debitCents || creditCents) lines.push({ account: acct, debit: debitCents / 100, credit: creditCents / 100, purpose });
  };
  const source = input.sourceId ? config.sources.find((s) => s.id === input.sourceId) : undefined;
  let chargeNetCents = 0;
  let chargeVatCents = 0;

  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) blockers.push("Amount must be greater than zero.");
  if (!input.reference.trim()) blockers.push("Supporting reference/evidence is required.");
  if (!ctx.configValid) blockers.push("ERPNext account validation must be valid before Finance can approve postings.");
  if (ctx.legacyHeld) policyBlocks.push("A linked legacy financial record is under Finance review hold. It cannot be posted from this desk.");

  if (input.kind === "invoice") {
    const inv = ctx.invoice;
    if (!inv) blockers.push("Select the prepared AURA invoice for this deal.");
    else {
      if (inv.status === "void") blockers.push("The selected invoice is void.");
      if (inv.kind === "reservation") policyBlocks.push(ctx.advancePolicy
        ? "A deposit request is not a sales invoice and does not post revenue. Submit a Payment request against this reservation invoice instead."
        : ADVANCE_VAT_BLOCK);
      if (inv.amountCents !== input.amountCents) blockers.push("Amount must equal the prepared invoice total.");
      // An advance is not a vehicle sale. Until its tax policy is approved,
      // do not invent revenue/VAT entries or require final-sale prerequisites.
      if (inv.kind !== "reservation") {
      if (ctx.advancePolicy && ctx.unresolvedAdvance) blockers.push("Finish or reconcile approved/failed deposit postings before approving the final invoice.");
      if (!ctx.vehicle?.vin) blockers.push("Assign the VIN through the existing allocation controls before invoicing.");
      if (ctx.dealStage && !["committed", "delivered"].includes(ctx.dealStage) &&
          !(ctx.dealStage === "desking" && ctx.hasInvoiceReservation)) {
        blockers.push("Reserve this VIN for this deal before invoicing. Commitment and handover still require settlement.");
      }
      const model = ctx.vehicle ? config.models.find((m) =>
        normalizeModelKey(m.make) === normalizeModelKey(ctx.vehicle!.make) &&
        normalizeModelKey(m.model) === normalizeModelKey(ctx.vehicle!.model)) : undefined;
      const income = (ctx.vehicle?.dutyFree ? model?.dutyFreeIncome : model?.income)?.trim() ?? "";
      if (!income) blockers.push(ctx.vehicle?.dutyFree
        ? "Configure this model's duty-free income account; normal income is never reused."
        : "Configure this vehicle model's income account in Finance mappings.");
      const tax = inv.taxCents;
      if (ctx.advancePolicy && ctx.fullSaleAmountCents != null && inv.amountCents !== ctx.fullSaleAmountCents) {
        blockers.push("This is not the full 14%-VAT vehicle invoice. Do not deduct the deposit from the invoice value; regenerate the correct final invoice before resubmitting.");
      }
      if (ctx.advancePolicy && Math.abs(tax - Math.round((inv.amountCents - tax) * 0.14)) > 1) {
        blockers.push("The final invoice must contain the full sale value and 14% VAT before applying deposits. Correct the invoice tax basis before resubmitting.");
      }
      line(account("receivables", "customer receivables"), inv.amountCents, 0, "Customer receivable (invoice total)");
      line(income, 0, inv.amountCents - tax, "Vehicle sale income");
      if (tax > 0) line(account("vatOutput", "VAT output"), 0, tax, "VAT output on delivery invoice");
      const applied = (ctx.advanceApplications ?? []).reduce((s, a) => s + a.amountCents, 0);
      if (applied > 0) {
        line(account("deposits", "customer deposits"), applied, 0, "Customer deposit applied");
        line(account("receivables", "customer receivables"), 0, applied, "Deposit credit against final invoice");
      }
      }
    }
  }

  if (input.kind === "payment") {
    const inv = ctx.invoice;
    if (!inv) blockers.push("Select the invoice this payment settles.");
    else {
      if (inv.kind === "reservation" && !ctx.advancePolicy) policyBlocks.push(ADVANCE_VAT_BLOCK);
      if (inv.status === "void") blockers.push("The selected invoice is void.");
      if (ctx.invoiceOutstandingCents != null && input.amountCents > ctx.invoiceOutstandingCents) {
        blockers.push("Amount exceeds the invoice's outstanding balance (overpayment).");
      }
      if (inv.kind !== "reservation" && !ctx.invoicePosted) {
        blockers.push("Post the invoice through an approved invoice request before allocating payments to it.");
      }
    }
    if (input.payerType === "financier") policyBlocks.push(FINANCIER_BLOCK);
    if (!source) blockers.push("Select a configured receiving source.");
    else if (!["bank", "cash"].includes(source.kind)) blockers.push("Receipts require a bank or cash source.");
    if (inv?.kind === "reservation" && ctx.advancePolicy) {
      if (ctx.finalSaleStarted) blockers.push("The final sale is already approved or posted. Record further receipts against the final invoice, not as another deposit.");
      if (input.paymentMethod === "bank_transfer" && source?.kind !== "bank") blockers.push("Bank transfers must use the actual receiving bank account, not petty cash.");
      if (input.paymentMethod === "cash" && source?.kind !== "cash") blockers.push("Cash receipts must use a cash receiving source.");
      line(source?.account ?? "", input.amountCents, 0, "Customer advance received");
      line(account("deposits", "customer deposits"), 0, input.amountCents, "Customer deposit liability (no VAT on receipt)");
    } else if (inv?.kind !== "reservation") {
      line(source?.account ?? "", input.amountCents, 0, `Receipt into ${source?.label ?? "source"}`);
      line(account("receivables", "customer receivables"), 0, input.amountCents, "Customer receivable settled");
    }
  }

  if (input.kind === "expense") {
    const cat = input.category;
    if (!cat || !["registration", "fuel", "detailing"].includes(cat)) blockers.push("Choose registration, fuel or detailing/PDI.");
    if (!source) blockers.push("Select a configured funding source.");
    else if (source.kind === "supplier") policyBlocks.push(SUPPLIER_PARTY_BLOCK);
    const label = cat === "detailing" ? "detailing/PDI" : cat ?? "expense";
    line(cat ? account(cat, `${label} expense`) : "", input.amountCents, 0, `${label} cost (dealer expense)`);
    line(source?.account ?? "", 0, input.amountCents, `Paid from ${source?.label ?? "source"}`);
    if (input.billingTreatment === "customer_billed") {
      const charge = input.customerChargeCents ?? 0;
      if (!Number.isSafeInteger(charge) || charge <= 0) blockers.push("Enter the separate customer charge amount.");
      const rule = config.customerCharges?.find((r) => r.category === cat);
      if (!rule?.approved || !rule.incomeAccount || rule.taxTreatment === "pending") {
        blockers.push(`Finance must approve a ${label} customer-charge income and tax mapping before billing the customer.`);
      }
      const { net, vat } = splitVat(charge, rule?.taxTreatment === "taxable" ? rule.vatRate : 0, !!rule?.amountIncludesVat);
      chargeNetCents = net;
      chargeVatCents = vat;
      line(account("receivables", "customer receivables"), net + vat, 0, "Customer charge receivable (charge invoice)");
      line(rule?.incomeAccount ?? "", 0, net, `${label} recovery income`);
      if (vat > 0) line(account("vatOutput", "VAT output"), 0, vat, "VAT output on customer charge");
    }
  }

  if (lines.some((l) => !l.account)) blockers.push("Every GL line needs a configured account.");
  const debitCents = lines.reduce((s, l) => s + Math.round(l.debit * 100), 0);
  const creditCents = lines.reduce((s, l) => s + Math.round(l.credit * 100), 0);
  if (debitCents !== creditCents) blockers.push("Debit and credit totals do not balance.");
  return {
    lines, blockers: [...new Set(blockers)], policyBlocks: [...new Set(policyBlocks)],
    debitCents, creditCents, chargeNetCents, chargeVatCents,
  };
}

export const toCents = (v: number) => Math.round(v * 100);
